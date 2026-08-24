import AppKit
import Foundation
import RelaunchCore

/// 0.0.13 自构建闭环（ADR 0022）：构建产物与在用 App 物理隔离，
/// 替换 / 回滚只经用户显式触发的原子交换，重启后恢复原会话。
enum SelfBuildModels {
    static let candidateDirectoryName = "dist-candidate"
    static let backupBundleName = "D Code.app.backup"
    static let previousBackupBundleName = "D Code.app.backup.previous"
    static let activeBundleName = "D Code.app"
    static let restartMarkerKey = "dcode.selfBuildRestart"
    static let restartIntentKindKey = "dcode.selfBuildRestartKind"
    static let pendingSessionKey = "dcode.selfBuildPendingSessionId"
    static let pendingSelfEvolutionRunKey = "dcode.selfEvolutionPendingRunId"
    static let sourceRootPreferenceKey = "dcode.selfBuildSourceRoot"
}

enum SelfBuildRestartIntentKind: Equatable, Sendable {
    case legacyBootstrap
    case ordinary
    case selfEvolution
    case selfEvolutionRollback
    case unknown(String)

    private static let ordinaryValue = "ordinary"
    private static let selfEvolutionValue = "self-evolution"
    private static let selfEvolutionRollbackValue = "self-evolution-rollback"

    var persistedValue: String? {
        switch self {
        case .legacyBootstrap:
            nil
        case .ordinary:
            Self.ordinaryValue
        case .selfEvolution:
            Self.selfEvolutionValue
        case .selfEvolutionRollback:
            Self.selfEvolutionRollbackValue
        case let .unknown(value):
            value
        }
    }

    static func resolve(persistedValue: String?, selfEvolutionRunID: String?) -> Self {
        guard let persistedValue else {
            return selfEvolutionRunID == nil ? .legacyBootstrap : .selfEvolution
        }
        switch persistedValue {
        case ordinaryValue:
            return .ordinary
        case selfEvolutionValue:
            return .selfEvolution
        case selfEvolutionRollbackValue:
            return .selfEvolutionRollback
        default:
            return .unknown(persistedValue)
        }
    }
}

enum SelfBuildRestartIntentCompatibility {
    static func targetSupportsTypedIntent(_ appVersion: String) -> Bool {
        let components = appVersion.split(separator: ".", omittingEmptySubsequences: false)
        guard components.count >= 3,
              let major = Int(components[0]),
              let minor = Int(components[1]),
              let patch = Int(components[2]) else { return false }
        return [major, minor, patch].lexicographicallyPrecedes([0, 0, 27]) == false
    }
}

struct SelfBuildRestartIntent: Equatable, Sendable {
    let kind: SelfBuildRestartIntentKind
    let sessionID: String?
    let selfEvolutionRunID: String?
}

enum SelfBuildBundleMetadata {
    static func appVersion(at bundleURL: URL) -> String? {
        let plistURL = bundleURL.appending(path: "Contents/Info.plist")
        return (NSDictionary(contentsOf: plistURL)?["CFBundleShortVersionString"] as? String)
    }
}

struct SelfBuildOutput: Equatable, Sendable {
    let succeeded: Bool
    let durationMs: Int
    /// 输出尾部（最多 200 行），供设置页呈现与排障。
    let outputTail: [String]
}

enum SelfBuildRunner {
    static let tailLineLimit = 200

    /// 运行构建脚本；产物目录由调用方经 additionalEnvironment（PI_DCODE_DIST_DIR）传给脚本。
    static func run(
        scriptURL: URL,
        additionalEnvironment: [String: String],
        currentDirectoryURL: URL
    ) async -> SelfBuildOutput {
        final class ResultBox: @unchecked Sendable {
            let lock = NSLock()
            var lines: [String] = []
            var succeeded = false
        }
        let box = ResultBox()
        let startedAt = Date()

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [scriptURL.path]
            var environment = ProcessInfo.processInfo.environment
            for (key, value) in additionalEnvironment { environment[key] = value }
            process.environment = environment
            process.currentDirectoryURL = currentDirectoryURL
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    return
                }
                let text = String(decoding: data, as: UTF8.self)
                box.lock.withLock {
                    box.lines.append(
                        contentsOf: text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
                    )
                }
            }
            process.terminationHandler = { terminated in
                pipe.fileHandleForReading.readabilityHandler = nil
                box.lock.withLock { box.succeeded = terminated.terminationStatus == 0 }
                continuation.resume()
            }
            do {
                try process.run()
            } catch {
                box.lock.withLock { box.succeeded = false }
                continuation.resume()
            }
        }

        let (lines, succeeded) = box.lock.withLock { (box.lines, box.succeeded) }
        var tail = Array(lines.suffix(tailLineLimit))
        if !succeeded && tail.isEmpty {
            tail = ["构建脚本未能启动：\(scriptURL.path)"]
        }
        return SelfBuildOutput(
            succeeded: succeeded,
            durationMs: max(0, Int(Date().timeIntervalSince(startedAt) * 1_000)),
            outputTail: tail
        )
    }
}

struct SelfBuildCandidateInfo: Equatable, Sendable {
    let bundlePath: String
    let appVersion: String
    let hostVersion: String
    let codesignValid: Bool
    let manifest: SelfBuildCandidateManifest?
    let issue: String?

    var isReady: Bool { codesignValid && manifest?.isValid == true && issue == nil }
}

enum SelfBuildCandidateValidator {
    /// 校验候选：签名、App 版本、内嵌 Host 版本一致性。任一不过即不可重启。
    static func validate(candidateBundleURL: URL) -> SelfBuildCandidateInfo {
        let infoPlistURL = candidateBundleURL.appending(path: "Contents/Info.plist")
        let hostPackageURL = candidateBundleURL.appending(path: "Contents/Resources/host/package.json")
        let relaunchHelperURL = SelfBuildRelaunchLauncher.helperURL(bundleURL: candidateBundleURL)
        let relaunchHelperExecutableURL = SelfBuildRelaunchLauncher.helperExecutableURL(
            helperAppURL: relaunchHelperURL
        )
        guard let plist = NSDictionary(contentsOf: infoPlistURL) else {
            return SelfBuildCandidateInfo(
                bundlePath: candidateBundleURL.path,
                appVersion: "",
                hostVersion: "",
                codesignValid: false,
                manifest: nil,
                issue: "候选缺少 Info.plist"
            )
        }
        let appVersion = (plist["CFBundleShortVersionString"] as? String) ?? ""
        let manifest = SelfBuildCandidateManifest.load(from: candidateBundleURL)
        var hostVersion = ""
        if let data = try? Data(contentsOf: hostPackageURL),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let version = object["version"] as? String {
            hostVersion = version
        }

        let codesign = Process()
        codesign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        codesign.arguments = ["--verify", "--deep", "--strict", candidateBundleURL.path]
        codesign.standardOutput = FileHandle.nullDevice
        codesign.standardError = FileHandle.nullDevice
        let codesignValid: Bool
        do {
            try codesign.run()
            codesign.waitUntilExit()
            codesignValid = codesign.terminationStatus == 0
        } catch {
            codesignValid = false
        }

        var issue: String?
        if appVersion.isEmpty { issue = "候选缺少 App 版本" }
        else if hostVersion.isEmpty { issue = "候选缺少内嵌 Host 版本" }
        else if appVersion != hostVersion { issue = "App 版本 \(appVersion) 与内嵌 Host \(hostVersion) 不一致" }
        else if SelfBuildRestartIntentCompatibility.targetSupportsTypedIntent(appVersion),
                !FileManager.default.fileExists(atPath: relaunchHelperURL.path) {
            issue = "候选缺少 Relaunch Helper"
        }
        else if SelfBuildRestartIntentCompatibility.targetSupportsTypedIntent(appVersion),
                !FileManager.default.isExecutableFile(atPath: relaunchHelperExecutableURL.path) {
            issue = "候选 Relaunch Helper 不可执行"
        }
        else if manifest == nil { issue = "候选缺少来源与验证清单" }
        else if manifest?.isValid != true { issue = "候选来源或自动门禁清单无效" }
        else if !codesignValid { issue = "候选签名校验未通过" }
        return SelfBuildCandidateInfo(
            bundlePath: candidateBundleURL.path,
            appVersion: appVersion,
            hostVersion: hostVersion,
            codesignValid: codesignValid,
            manifest: manifest,
            issue: issue
        )
    }
}

enum SelfBuildBundleSwapper {
    struct SwapResult: Equatable, Sendable {
        let succeeded: Bool
        let issue: String?
    }

    static func backupExists(distDirectory: URL) -> Bool {
        FileManager.default.fileExists(
            atPath: distDirectory.appending(path: SelfBuildModels.backupBundleName).path
        )
    }

    /// 原子交换：当前 → backup（覆盖旧备份），候选 → 当前。任一步失败全量回退。
    static func installCandidate(candidateBundleURL: URL, distDirectory: URL) -> SwapResult {
        let fileManager = FileManager.default
        let activeURL = distDirectory.appending(path: SelfBuildModels.activeBundleName)
        let backupURL = distDirectory.appending(path: SelfBuildModels.backupBundleName)
        let previousBackupURL = distDirectory.appending(path: SelfBuildModels.previousBackupBundleName)
        guard fileManager.fileExists(atPath: candidateBundleURL.path) else {
            return SwapResult(succeeded: false, issue: "候选不存在：\(candidateBundleURL.path)")
        }
        guard !fileManager.fileExists(atPath: previousBackupURL.path) else {
            return SwapResult(succeeded: false, issue: "存在未完成的候选交换备份，请先恢复后再试")
        }
        if fileManager.fileExists(atPath: backupURL.path) {
            do { try fileManager.moveItem(at: backupURL, to: previousBackupURL) }
            catch { return SwapResult(succeeded: false, issue: "无法暂存旧备份：\(error.localizedDescription)") }
        }
        guard fileManager.fileExists(atPath: activeURL.path) else {
            do { try fileManager.moveItem(at: candidateBundleURL, to: activeURL) }
            catch {
                restorePreviousBackup(fileManager: fileManager, from: previousBackupURL, to: backupURL)
                return SwapResult(succeeded: false, issue: "无法安装候选：\(error.localizedDescription)")
            }
            return SwapResult(succeeded: true, issue: nil)
        }
        do {
            try fileManager.moveItem(at: activeURL, to: backupURL)
        } catch {
            restorePreviousBackup(fileManager: fileManager, from: previousBackupURL, to: backupURL)
            return SwapResult(succeeded: false, issue: "无法备份当前 App：\(error.localizedDescription)")
        }
        do {
            try fileManager.moveItem(at: candidateBundleURL, to: activeURL)
        } catch {
            try? fileManager.moveItem(at: backupURL, to: activeURL)
            restorePreviousBackup(fileManager: fileManager, from: previousBackupURL, to: backupURL)
            return SwapResult(succeeded: false, issue: "无法安装候选（已回退）：\(error.localizedDescription)")
        }
        return SwapResult(succeeded: true, issue: nil)
    }

    /// Helper 已成功启动后才提交候选交换；此前保留的更旧备份此时退出事务。
    static func commitCandidateInstall(distDirectory: URL) {
        let previousBackupURL = distDirectory.appending(path: SelfBuildModels.previousBackupBundleName)
        if FileManager.default.fileExists(atPath: previousBackupURL.path) {
            try? FileManager.default.removeItem(at: previousBackupURL)
        }
    }

    /// Helper / 回执失败时恢复交换前的三条身份：active、backup 与 candidate。
    static func restoreCandidateInstall(
        candidateBundleURL: URL,
        distDirectory: URL,
        hadActiveBundle: Bool
    ) -> SwapResult {
        let fileManager = FileManager.default
        let activeURL = distDirectory.appending(path: SelfBuildModels.activeBundleName)
        let backupURL = distDirectory.appending(path: SelfBuildModels.backupBundleName)
        let previousBackupURL = distDirectory.appending(path: SelfBuildModels.previousBackupBundleName)
        guard fileManager.fileExists(atPath: activeURL.path) else {
            return SwapResult(succeeded: false, issue: "恢复失败：已安装候选不存在")
        }
        guard !fileManager.fileExists(atPath: candidateBundleURL.path) else {
            return SwapResult(succeeded: false, issue: "恢复失败：候选目录已被其他内容占用")
        }
        do {
            try fileManager.createDirectory(
                at: candidateBundleURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try fileManager.moveItem(at: activeURL, to: candidateBundleURL)
            if hadActiveBundle {
                guard fileManager.fileExists(atPath: backupURL.path) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                try fileManager.moveItem(at: backupURL, to: activeURL)
            }
            restorePreviousBackup(fileManager: fileManager, from: previousBackupURL, to: backupURL)
            return SwapResult(succeeded: true, issue: nil)
        } catch {
            if !fileManager.fileExists(atPath: activeURL.path),
               fileManager.fileExists(atPath: candidateBundleURL.path) {
                try? fileManager.moveItem(at: candidateBundleURL, to: activeURL)
            }
            return SwapResult(succeeded: false, issue: "恢复候选交换失败：\(error.localizedDescription)")
        }
    }

    /// 回滚：backup ↔ 当前。
    static func rollback(distDirectory: URL) -> SwapResult {
        let fileManager = FileManager.default
        let activeURL = distDirectory.appending(path: SelfBuildModels.activeBundleName)
        let backupURL = distDirectory.appending(path: SelfBuildModels.backupBundleName)
        let previousBackupURL = distDirectory.appending(path: SelfBuildModels.previousBackupBundleName)
        let stagingURL = distDirectory.appending(path: "\(SelfBuildModels.backupBundleName).staging")
        guard !fileManager.fileExists(atPath: previousBackupURL.path) else {
            return SwapResult(succeeded: false, issue: "存在未完成的候选交换，不能执行普通回滚")
        }
        guard fileManager.fileExists(atPath: backupURL.path) else {
            return SwapResult(succeeded: false, issue: "没有可回滚的备份")
        }
        if fileManager.fileExists(atPath: stagingURL.path) {
            try? fileManager.removeItem(at: stagingURL)
        }
        do {
            if fileManager.fileExists(atPath: activeURL.path) {
                try fileManager.moveItem(at: activeURL, to: stagingURL)
            }
            try fileManager.moveItem(at: backupURL, to: activeURL)
            try fileManager.moveItem(at: stagingURL, to: backupURL)
            return SwapResult(succeeded: true, issue: nil)
        } catch {
            if !fileManager.fileExists(atPath: activeURL.path),
               fileManager.fileExists(atPath: stagingURL.path) {
                try? fileManager.moveItem(at: stagingURL, to: activeURL)
            }
            return SwapResult(succeeded: false, issue: "回滚失败（已尽量恢复）：\(error.localizedDescription)")
        }
    }

    private static func restorePreviousBackup(
        fileManager: FileManager,
        from previousBackupURL: URL,
        to backupURL: URL
    ) {
        guard fileManager.fileExists(atPath: previousBackupURL.path),
              !fileManager.fileExists(atPath: backupURL.path) else { return }
        try? fileManager.moveItem(at: previousBackupURL, to: backupURL)
    }
}
enum SelfBuildRelaunchError: LocalizedError, Equatable {
    case helperMissing(URL)
    case helperNotExecutable(URL)
    case helperLaunchFailed(URL, Int32)
    case invalidTarget(URL)
    case invalidDistDirectory(URL)

    var errorDescription: String? {
        switch self {
        case let .helperMissing(url): "Relaunch Helper 不存在：\(url.path)"
        case let .helperNotExecutable(url): "Relaunch Helper 不可执行：\(url.path)"
        case let .helperLaunchFailed(url, status): "Relaunch Helper 启动失败（\(status)）：\(url.path)"
        case let .invalidTarget(url): "目标 App 不在当前 Self-build 的 dist/D Code.app：\(url.path)"
        case let .invalidDistDirectory(url): "Self-build dist 目录不属于当前源码 checkout：\(url.path)"
        }
    }
}

enum SelfBuildRelaunchLauncher {
    static let helperResourceName = "DCodeRelaunchHelper.app"
    static let helperExecutableName = "DCodeRelaunchHelper"
    static let helperBundleIdentifier = "com.diwu.pidcode.relaunch-helper"
    static let stagedHelperName = ".DCodeRelaunchHelper.app"

    static func helperURL(bundleURL: URL = Bundle.main.bundleURL) -> URL {
        bundleURL
            .appending(path: "Contents", directoryHint: .isDirectory)
            .appending(path: "Resources", directoryHint: .isDirectory)
            .appending(path: helperResourceName)
    }

    static func helperExecutableURL(helperAppURL: URL) -> URL {
        helperAppURL
            .appending(path: "Contents/MacOS", directoryHint: .isDirectory)
            .appending(path: helperExecutableName)
    }

    static func launch(
        _ request: RelaunchHelperRequest,
        bundleURL: URL = Bundle.main.bundleURL
    ) throws {
        let helperURL = try stageHelper(
            bundleURL: bundleURL,
            distDirectoryURL: request.distDirectoryURL
        )
        try launch(request, helperURL: helperURL)
    }

    static func stageHelper(
        bundleURL: URL,
        distDirectoryURL: URL,
        fileManager: FileManager = .default
    ) throws -> URL {
        let helperURL = helperURL(bundleURL: bundleURL)
        let sourceExecutableURL = helperExecutableURL(helperAppURL: helperURL)
        guard fileManager.fileExists(atPath: helperURL.path) else {
            throw SelfBuildRelaunchError.helperMissing(helperURL)
        }
        guard fileManager.isExecutableFile(atPath: sourceExecutableURL.path) else {
            throw SelfBuildRelaunchError.helperNotExecutable(sourceExecutableURL)
        }
        try fileManager.createDirectory(at: distDirectoryURL, withIntermediateDirectories: true)
        let stagedURL = distDirectoryURL.appending(path: stagedHelperName)
        if fileManager.fileExists(atPath: stagedURL.path) {
            try fileManager.removeItem(at: stagedURL)
        }
        try fileManager.copyItem(at: helperURL, to: stagedURL)
        try fileManager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: helperExecutableURL(helperAppURL: stagedURL).path
        )
        return stagedURL
    }

    static func launchStaged(_ request: RelaunchHelperRequest) throws {
        let helperURL = request.distDirectoryURL.appending(path: stagedHelperName)
        try launch(request, helperURL: helperURL)
    }

    static func launch(_ request: RelaunchHelperRequest, helperURL: URL) throws {
        let helperExecutableURL = helperExecutableURL(helperAppURL: helperURL)
        guard FileManager.default.fileExists(atPath: helperURL.path) else {
            throw SelfBuildRelaunchError.helperMissing(helperURL)
        }
        guard FileManager.default.isExecutableFile(atPath: helperExecutableURL.path) else {
            throw SelfBuildRelaunchError.helperNotExecutable(helperExecutableURL)
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", "-j", helperURL.path, "--args"] + request.commandArguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw SelfBuildRelaunchError.helperLaunchFailed(helperURL, process.terminationStatus)
        }
        let target = helperURL.standardizedFileURL.resolvingSymlinksInPath()
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if NSWorkspace.shared.runningApplications.contains(where: { application in
                application.bundleIdentifier == helperBundleIdentifier
                    && !application.isTerminated
                    && application.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == target
            }) {
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        throw SelfBuildRelaunchError.helperLaunchFailed(helperURL, -1)
    }
}
