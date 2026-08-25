import AppKit
import Foundation
import Observation
import RelaunchCore

private enum ProductStoreVersionPolicy {
    static let minimumVersion = "0.0.28"

    static func allows(_ version: String) -> Bool {
        let components = version.split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 3,
              let major = Int(components[0]),
              let minor = Int(components[1]),
              let patch = Int(components[2]) else { return false }
        return (major, minor, patch) >= (0, 0, 28)
    }

    static func rejection(_ version: String) -> String {
        "Product Store 已晋升到 0.0.28 schema；不支持切换到 \(version)，最低可运行版本为 \(minimumVersion)。"
    }
}

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

    enum RestartStage: Equatable {
        case savingSession
        case validatingCandidate
        case swappingApp
        case closingCurrentVersion
        case awaitingNewVersion

        var message: String {
            switch self {
            case .savingSession: "正在保存会话"
            case .validatingCandidate: "正在校验 Candidate"
            case .swappingApp: "正在交换 App"
            case .closingCurrentVersion: "正在关闭当前版本"
            case .awaitingNewVersion: "新版本将自动重新打开"
            }
        }
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
    private(set) var restartStage: RestartStage?
    private(set) var candidateWasConsumed = false

    var isRestarting: Bool { restartStage != nil }

    var rootDirectory: URL
    @ObservationIgnored var distDirectory: URL
    @ObservationIgnored var scriptURL: URL
    @ObservationIgnored private let followsRootDistDirectory: Bool
    @ObservationIgnored private let followsRootScriptURL: Bool
    @ObservationIgnored private let verificationRunner: @Sendable (URL) async -> [SelfBuildCommandResult]
    @ObservationIgnored private let buildRunner: @Sendable (URL, [String: String], URL) async -> SelfBuildOutput
    @ObservationIgnored private let snapshotter: @Sendable (URL) throws -> SelfBuildSourceSnapshot
    @ObservationIgnored private let candidateInstaller: @Sendable (URL, URL) -> SelfBuildBundleSwapper.SwapResult
    @ObservationIgnored private let relaunchHelperPreparer: @Sendable (URL, URL) throws -> Void
    @ObservationIgnored private let relaunchHelperLauncher: @Sendable (RelaunchHelperRequest) throws -> Void
    @ObservationIgnored private let terminateApplication: @MainActor @Sendable () -> Void
    @ObservationIgnored private var restartInFlight = false
    @ObservationIgnored private var relaunchHelperPrepared = false

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
        snapshotter: @escaping @Sendable (URL) throws -> SelfBuildSourceSnapshot = SelfBuildSourceSnapshotter.capture,
        candidateInstaller: @escaping @Sendable (URL, URL) -> SelfBuildBundleSwapper.SwapResult = {
            SelfBuildBundleSwapper.installCandidate(candidateBundleURL: $0, distDirectory: $1)
        },
        activeManifestOverride: SelfBuildCandidateManifest? = nil,
        relaunchHelperPreparer: (@Sendable (URL, URL) throws -> Void)? = nil,
        relaunchHelperLauncher: (@Sendable (RelaunchHelperRequest) throws -> Void)? = nil,
        terminateApplication: @escaping @MainActor @Sendable () -> Void = {
            NSApp.terminate(nil)
        }
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
        self.candidateInstaller = candidateInstaller
        if let relaunchHelperLauncher {
            self.relaunchHelperPreparer = relaunchHelperPreparer ?? { _, _ in }
            self.relaunchHelperLauncher = relaunchHelperLauncher
            relaunchHelperPrepared = relaunchHelperPreparer == nil
        } else {
            self.relaunchHelperPreparer = relaunchHelperPreparer ?? { bundleURL, distURL in
                _ = try SelfBuildRelaunchLauncher.stageHelper(
                    bundleURL: bundleURL,
                    distDirectoryURL: distURL
                )
            }
            self.relaunchHelperLauncher = { request in
                try SelfBuildRelaunchLauncher.launchStaged(request)
            }
        }
        self.terminateApplication = terminateApplication
        sourceRootIssue = info == nil ? "尚未找到有效的 D Code 源码 checkout" : info?.issue
        activeManifest = activeManifestOverride
            ?? SelfBuildCandidateManifest.load(from: Bundle.main.bundleURL)
        let runningBundleURL = Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath()
        let activeBundleURL = self.distDirectory
            .appending(path: SelfBuildModels.activeBundleName)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        if Self.restartIntent() != nil, runningBundleURL == activeBundleURL {
            // 若旧进程在 swap 后、helper 提交前异常退出，用户手动打开已经安装的
            // active Candidate 即构成恢复证据；清掉上一次 backup 暂存，保留当前
            // active 与其直接前任 backup，避免下一轮被陈旧事务永久阻塞。
            SelfBuildBundleSwapper.commitCandidateInstall(distDirectory: self.distDirectory)
        }
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
        guard !isRestarting else { return false }
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
        candidateWasConsumed = false
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
        guard !isRestarting, phase != .building, phase != .verifying else { return }
        issue = nil
        candidate = nil
        candidateWasConsumed = false
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
        case relaunchFailed(String)
    }

    @discardableResult
    func beginRestartPreparation() -> Bool {
        guard !restartInFlight else { return false }
        restartInFlight = true
        restartStage = .savingSession
        issue = nil
        return true
    }

    func failRestartPreparation(_ message: String) {
        guard restartInFlight, restartStage == .savingSession else { return }
        finishRestartFailure(
            message,
            phase: candidate?.isReady == true ? .built : .failed
        )
    }

    /// 受控重启到候选：校验 → 暂存 helper / 持久化 intent → 原子交换 → 启动独立 helper → 关机。
    /// Helper 在旧 PID 消失前不会打开新 App，因此不得在这里预先调用 NSWorkspace。
    func restartIntoCandidate(
        pendingSessionID: String?,
        selfEvolutionRunID: String? = nil
    ) async -> RestartOutcome {
        guard !restartInFlight || restartStage == .savingSession else {
            return .validationFailed("重启已在进行中")
        }
        if !restartInFlight {
            restartInFlight = true
        }
        restartStage = .validatingCandidate
        guard phase == .built, !candidateWasConsumed else {
            finishRestartFailure("尚无可用的候选构建", phase: .failed)
            return .validationFailed("尚无可用的候选构建")
        }

        let info = SelfBuildCandidateValidator.validate(candidateBundleURL: candidateBundleURL)
        candidate = info
        guard info.isReady else {
            let message = info.issue ?? "候选校验未通过"
            finishRestartFailure(message, phase: .failed)
            return .validationFailed(message)
        }
        guard ProductStoreVersionPolicy.allows(info.appVersion) else {
            let message = ProductStoreVersionPolicy.rejection(info.appVersion)
            finishRestartFailure(message, phase: .failed)
            return .validationFailed(message)
        }
        guard sourceStillMatchesCandidate() else {
            let message = "候选来源 digest 与当前源码不匹配；已拒绝交换"
            finishRestartFailure(message, phase: .failed)
            return .validationFailed(message)
        }

        // Candidate 已通过签名、manifest 与 Helper 门禁；优先暂存目标版本自带
        // 的 Helper，避免当前 App 的旧 Helper 覆盖本次启动协议修复。
        guard prepareRelaunchHelperIfNeeded(from: [candidateBundleURL, Bundle.main.bundleURL]) else {
            return .relaunchFailed(issue ?? "Relaunch Helper 准备失败")
        }

        markRestart(
            kind: selfEvolutionRunID == nil ? .ordinary : .selfEvolution,
            targetAppVersion: info.appVersion,
            pendingSessionID: pendingSessionID,
            selfEvolutionRunID: selfEvolutionRunID
        )

        restartStage = .swappingApp
        let activeURL = activeBundleURL
        let hadActiveBundle = FileManager.default.fileExists(atPath: activeURL.path)
        let swap = candidateInstaller(candidateBundleURL, distDirectory)
        refreshBackupState()
        guard swap.succeeded else {
            SelfBuildModel.acknowledgeRestartIntent()
            finishRestartFailure(swap.issue ?? "交换失败", phase: .failed)
            return .swapFailed(swap.issue ?? "交换失败")
        }
        candidateWasConsumed = true
        return await relaunchAfterPreparedSwap(
            hadActiveBundleBeforeSwap: hadActiveBundle,
            candidateURL: candidateBundleURL
        )
    }

    /// 回滚到备份构建并重启。
    func rollbackAndRestart(pendingSessionID: String?) async -> RestartOutcome {
        guard !restartInFlight || restartStage == .savingSession else {
            return .validationFailed("重启已在进行中")
        }
        if !restartInFlight {
            restartInFlight = true
        }
        guard let targetAppVersion = backupAppVersion() else {
            finishRestartFailure("备份构建缺少可核对的 App 版本", phase: .failed)
            return .swapFailed("备份构建缺少可核对的 App 版本")
        }
        guard ProductStoreVersionPolicy.allows(targetAppVersion) else {
            let message = ProductStoreVersionPolicy.rejection(targetAppVersion)
            finishRestartFailure(message, phase: .failed)
            return .validationFailed(message)
        }
        guard prepareRollbackRestartBeforeSwap(
            kind: .ordinary,
            targetAppVersion: targetAppVersion,
            pendingSessionID: pendingSessionID,
            selfEvolutionRunID: nil
        ) else {
            return .relaunchFailed(issue ?? "Relaunch Helper 准备失败")
        }
        let hadActiveBundle = FileManager.default.fileExists(atPath: activeBundleURL.path)
        let swap = swapToBackup()
        guard swap.succeeded else {
            cancelPreparedRestartAfterSwapFailure(swap.issue ?? "回滚失败")
            return .swapFailed(swap.issue ?? "回滚失败")
        }
        return await relaunchAfterPreparedSwap(
            hadActiveBundleBeforeSwap: hadActiveBundle,
            candidateURL: nil
        )
    }

    func swapToBackup() -> SelfBuildBundleSwapper.SwapResult {
        let swap = SelfBuildBundleSwapper.rollback(distDirectory: distDirectory)
        refreshBackupState()
        return swap
    }

    /// 回滚在交换前暂存 helper 并写 typed intent，消除“bundle 已换、恢复事实缺席”的窗口。
    func prepareRollbackRestartBeforeSwap(
        kind: SelfBuildRestartIntentKind,
        targetAppVersion: String,
        pendingSessionID: String?,
        selfEvolutionRunID: String?
    ) -> Bool {
        guard restartInFlight,
              restartStage == .savingSession || restartStage == .validatingCandidate else { return false }
        guard ProductStoreVersionPolicy.allows(targetAppVersion) else {
            finishRestartFailure(ProductStoreVersionPolicy.rejection(targetAppVersion), phase: .failed)
            return false
        }
        let backupURL = distDirectory.appending(path: SelfBuildModels.backupBundleName)
        guard prepareRelaunchHelperIfNeeded(from: [Bundle.main.bundleURL, activeBundleURL, backupURL]) else {
            return false
        }
        markRestart(
            kind: kind,
            targetAppVersion: targetAppVersion,
            pendingSessionID: pendingSessionID,
            selfEvolutionRunID: selfEvolutionRunID
        )
        restartStage = .swappingApp
        return true
    }

    func cancelPreparedRestartAfterSwapFailure(_ message: String) {
        SelfBuildModel.acknowledgeRestartIntent()
        finishRestartFailure(message, phase: .failed)
    }

    /// 已完成交换且 intent 已预写；不可逆回执仍在 helper 可启动前完成。
    func relaunchAfterPreparedSwap(
        hadActiveBundleBeforeSwap: Bool,
        candidateURL: URL? = nil,
        finalize: (@MainActor @Sendable () async throws -> Void)? = nil
    ) async -> RestartOutcome {
        guard restartInFlight,
              restartStage == .swappingApp,
              SelfBuildModel.restartIntent() != nil else {
            return .validationFailed("重启交换缺少预写的恢复 intent")
        }
        return await completePreparedRelaunch(
            hadActiveBundleBeforeSwap: hadActiveBundleBeforeSwap,
            candidateURL: candidateURL,
            finalize: finalize
        )
    }

    /// Bootstrap recovery 也必须由同一个 helper 交接；不交换 bundle，只保留已有 marker。
    func relaunchCurrentAppForRecovery(pendingSessionID: String?) async -> RestartOutcome {
        guard !restartInFlight else { return .validationFailed("重启已在进行中") }
        guard SelfBuildModel.restartIntent() != nil else {
            return .validationFailed("没有可恢复的 Bootstrap marker")
        }
        guard prepareRelaunchHelperIfNeeded(from: [Bundle.main.bundleURL, activeBundleURL]) else {
            return .relaunchFailed(issue ?? "Relaunch Helper 准备失败")
        }
        restartInFlight = true
        restartStage = .validatingCandidate
        let targetAppVersion = SelfBuildBundleMetadata.appVersion(at: activeBundleURL) ?? HostCompatibility.appVersion
        markRestart(
            kind: .legacyBootstrap,
            targetAppVersion: targetAppVersion,
            pendingSessionID: pendingSessionID,
            selfEvolutionRunID: nil
        )
        do {
            try launchRelaunchHelper()
        } catch {
            finishRestartFailure("Bootstrap Relaunch Helper 启动失败：\(error.localizedDescription)", phase: .failed)
            return .relaunchFailed(error.localizedDescription)
        }
        restartStage = .closingCurrentVersion
        await Task.yield()
        restartStage = .awaitingNewVersion
        terminateApplication()
        return .restarted
    }

    func sourceStillMatchesCandidate() -> Bool {
        guard let manifest = candidate?.manifest ?? SelfBuildCandidateManifest.load(from: candidateBundleURL),
              let snapshot = try? snapshotter(rootDirectory) else { return false }
        return snapshot.revision == manifest.sourceRevision
            && snapshot.dirty == manifest.sourceDirty
            && snapshot.changedFileCount == manifest.changedFileCount
            && snapshot.digest == manifest.sourceDigest
    }

    private var activeBundleURL: URL {
        distDirectory.appending(path: SelfBuildModels.activeBundleName)
    }

    private func completePreparedRelaunch(
        hadActiveBundleBeforeSwap: Bool,
        candidateURL: URL?,
        finalize: (@MainActor @Sendable () async throws -> Void)? = nil
    ) async -> RestartOutcome {
        var finalizedIrreversibleReceipt = false
        if let finalize {
            do {
                try await finalize()
                finalizedIrreversibleReceipt = true
            } catch {
                SelfBuildModel.acknowledgeRestartIntent()
                let restoreIssue = restoreSwapAfterFailedRelaunch(
                    hadActiveBundleBeforeSwap: hadActiveBundleBeforeSwap,
                    candidateURL: candidateURL
                )
                let message = [
                    "重启前回执未能安全保存：\(error.localizedDescription)",
                    restoreIssue.map { "交换回滚也失败：\($0)" },
                ]
                .compactMap { $0 }
                .joined(separator: "；")
                let recoveredCandidate = candidateURL != nil
                    && restoreIssue == nil
                    && candidate?.isReady == true
                finishRestartFailure(message, phase: recoveredCandidate ? .built : .failed)
                return .relaunchFailed(message)
            }
        }
        do {
            try launchRelaunchHelper()
        } catch {
            if finalizedIrreversibleReceipt {
                let message = "Relaunch Helper 启动失败，但回执和目标 App 已完成交换；恢复标记已保留。请退出当前 D Code 后手动打开 dist/D Code.app：\(error.localizedDescription)"
                finishRestartFailure(message, phase: .failed)
                return .relaunchFailed(message)
            }
            SelfBuildModel.acknowledgeRestartIntent()
            let restoreIssue = restoreSwapAfterFailedRelaunch(
                hadActiveBundleBeforeSwap: hadActiveBundleBeforeSwap,
                candidateURL: candidateURL
            )
            let message = [
                "Relaunch Helper 启动失败：\(error.localizedDescription)",
                restoreIssue.map { "交换回滚也失败：\($0)" },
            ]
            .compactMap { $0 }
            .joined(separator: "；")
            let recoveredCandidate = candidateURL != nil
                && restoreIssue == nil
                && candidate?.isReady == true
            finishRestartFailure(message, phase: recoveredCandidate ? .built : .failed)
            return .relaunchFailed(message)
        }
        if candidateURL != nil {
            SelfBuildBundleSwapper.commitCandidateInstall(distDirectory: distDirectory)
        }
        restartStage = .closingCurrentVersion
        await Task.yield()
        restartStage = .awaitingNewVersion
        terminateApplication()
        return .restarted
    }

    private func launchRelaunchHelper() throws {
        let activeURL = activeBundleURL
        let expectedDistURL = rootDirectory
            .appending(path: "dist", directoryHint: .isDirectory)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let actualDistURL = distDirectory.standardizedFileURL.resolvingSymlinksInPath()
        guard actualDistURL == expectedDistURL else {
            throw SelfBuildRelaunchError.invalidDistDirectory(actualDistURL)
        }
        guard RelaunchHelperPathPolicy.canonicalAppURL(
            appURL: activeURL,
            distDirectoryURL: actualDistURL
        ) != nil else {
            throw SelfBuildRelaunchError.invalidTarget(activeURL)
        }
        try relaunchHelperLauncher(RelaunchHelperRequest(
            oldPID: ProcessInfo.processInfo.processIdentifier,
            appURL: activeURL,
            distDirectoryURL: actualDistURL
        ))
    }

    private func prepareRelaunchHelperIfNeeded(from bundleURLs: [URL]) -> Bool {
        if relaunchHelperPrepared { return true }
        var failures: [String] = []
        var attempted: Set<String> = []
        for bundleURL in bundleURLs {
            let standardized = bundleURL.standardizedFileURL.path
            guard attempted.insert(standardized).inserted else { continue }
            do {
                try relaunchHelperPreparer(bundleURL, distDirectory)
                relaunchHelperPrepared = true
                return true
            } catch {
                failures.append(error.localizedDescription)
            }
        }
        let detail = failures.last ?? "没有可用的 Helper 来源"
        finishRestartFailure(
            "Relaunch Helper 准备失败：\(detail)",
            phase: candidate?.isReady == true ? .built : .failed
        )
        return false
    }

    private func restoreSwapAfterFailedRelaunch(
        hadActiveBundleBeforeSwap: Bool,
        candidateURL: URL?
    ) -> String? {
        if let candidateURL {
            let restore = SelfBuildBundleSwapper.restoreCandidateInstall(
                candidateBundleURL: candidateURL,
                distDirectory: distDirectory,
                hadActiveBundle: hadActiveBundleBeforeSwap
            )
            refreshBackupState()
            if restore.succeeded { candidateWasConsumed = false }
            return restore.succeeded ? nil : restore.issue
        }
        if hadActiveBundleBeforeSwap {
            let restore = SelfBuildBundleSwapper.rollback(distDirectory: distDirectory)
            refreshBackupState()
            return restore.succeeded ? nil : restore.issue
        }
        let fileManager = FileManager.default
        refreshBackupState()
        return fileManager.fileExists(atPath: activeBundleURL.path)
            ? nil
            : "恢复失败：当前 App 不存在"
    }

    private func finishRestartFailure(_ message: String, phase: Phase) {
        issue = message
        restartStage = nil
        restartInFlight = false
        relaunchHelperPrepared = false
        self.phase = phase
        refreshBackupState()
    }

    private func markRestart(
        kind: SelfBuildRestartIntentKind,
        targetAppVersion: String,
        pendingSessionID: String?,
        selfEvolutionRunID: String?
    ) {
        Self.persistRestartIntent(
            kind: kind,
            targetAppVersion: targetAppVersion,
            pendingSessionID: pendingSessionID,
            selfEvolutionRunID: selfEvolutionRunID
        )
    }
    nonisolated static func persistRestartIntent(
        kind: SelfBuildRestartIntentKind,
        targetAppVersion: String,
        pendingSessionID: String?,
        selfEvolutionRunID: String?,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(true, forKey: SelfBuildModels.restartMarkerKey)
        if SelfBuildRestartIntentCompatibility.targetSupportsTypedIntent(targetAppVersion),
           let persistedKind = kind.persistedValue {
            defaults.set(persistedKind, forKey: SelfBuildModels.restartIntentKindKey)
        } else {
            defaults.removeObject(forKey: SelfBuildModels.restartIntentKindKey)
        }
        if let pendingSessionID {
            defaults.set(pendingSessionID, forKey: SelfBuildModels.pendingSessionKey)
        } else {
            defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
        }
        if let selfEvolutionRunID {
            defaults.set(selfEvolutionRunID, forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
        } else {
            defaults.removeObject(forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
        }
    }

    func backupAppVersion() -> String? {
        SelfBuildBundleMetadata.appVersion(
            at: distDirectory.appending(path: SelfBuildModels.backupBundleName)
        )
    }

    /// 启动恢复先只读 intent；只有回执已经安全落盘后才 acknowledge。
    nonisolated static func restartIntent(defaults: UserDefaults = .standard) -> SelfBuildRestartIntent? {
        guard defaults.bool(forKey: SelfBuildModels.restartMarkerKey) else { return nil }
        let runID = defaults.string(forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
        return SelfBuildRestartIntent(
            kind: SelfBuildRestartIntentKind.resolve(
                persistedValue: defaults.string(forKey: SelfBuildModels.restartIntentKindKey),
                selfEvolutionRunID: runID
            ),
            sessionID: defaults.string(forKey: SelfBuildModels.pendingSessionKey),
            selfEvolutionRunID: runID
        )
    }

    nonisolated static func acknowledgeRestartIntent(defaults: UserDefaults = .standard) {
        defaults.set(false, forKey: SelfBuildModels.restartMarkerKey)
        defaults.removeObject(forKey: SelfBuildModels.restartIntentKindKey)
        defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
        defaults.removeObject(forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
    }

    /// 兼容旧测试 / 调用方；新启动路径必须使用 read → persist → acknowledge。
    nonisolated static func consumeRestartMarker() -> String? {
        let intent = restartIntent()
        if intent != nil { acknowledgeRestartIntent() }
        return intent?.sessionID
    }
}
