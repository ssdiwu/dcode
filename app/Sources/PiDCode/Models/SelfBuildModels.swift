import Foundation

/// 0.0.13 自构建闭环（ADR 0022）：构建产物与在用 App 物理隔离，
/// 替换 / 回滚只经用户显式触发的原子交换，重启后恢复原会话。
enum SelfBuildModels {
    static let candidateDirectoryName = "dist-candidate"
    static let backupBundleName = "D Code.app.backup"
    static let activeBundleName = "D Code.app"
    static let restartMarkerKey = "dcode.selfBuildRestart"
    static let pendingSessionKey = "dcode.selfBuildPendingSessionId"
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
    let issue: String?

    var isReady: Bool { codesignValid && issue == nil }
}

enum SelfBuildCandidateValidator {
    /// 校验候选：签名、App 版本、内嵌 Host 版本一致性。任一不过即不可重启。
    static func validate(candidateBundleURL: URL) -> SelfBuildCandidateInfo {
        let infoPlistURL = candidateBundleURL.appending(path: "Contents/Info.plist")
        let hostPackageURL = candidateBundleURL.appending(path: "Contents/Resources/host/package.json")
        guard let plist = NSDictionary(contentsOf: infoPlistURL) else {
            return SelfBuildCandidateInfo(bundlePath: candidateBundleURL.path, appVersion: "", hostVersion: "", codesignValid: false, issue: "候选缺少 Info.plist")
        }
        let appVersion = (plist["CFBundleShortVersionString"] as? String) ?? ""
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
        else if !codesignValid { issue = "候选签名校验未通过" }
        return SelfBuildCandidateInfo(
            bundlePath: candidateBundleURL.path,
            appVersion: appVersion,
            hostVersion: hostVersion,
            codesignValid: codesignValid,
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
        guard fileManager.fileExists(atPath: candidateBundleURL.path) else {
            return SwapResult(succeeded: false, issue: "候选不存在：\(candidateBundleURL.path)")
        }
        if fileManager.fileExists(atPath: backupURL.path) {
            do { try fileManager.removeItem(at: backupURL) }
            catch { return SwapResult(succeeded: false, issue: "无法移除旧备份：\(error.localizedDescription)") }
        }
        guard fileManager.fileExists(atPath: activeURL.path) else {
            do { try fileManager.moveItem(at: candidateBundleURL, to: activeURL) }
            catch { return SwapResult(succeeded: false, issue: "无法安装候选：\(error.localizedDescription)") }
            return SwapResult(succeeded: true, issue: nil)
        }
        do {
            try fileManager.moveItem(at: activeURL, to: backupURL)
        } catch {
            return SwapResult(succeeded: false, issue: "无法备份当前 App：\(error.localizedDescription)")
        }
        do {
            try fileManager.moveItem(at: candidateBundleURL, to: activeURL)
        } catch {
            try? fileManager.moveItem(at: backupURL, to: activeURL)
            return SwapResult(succeeded: false, issue: "无法安装候选（已回退）：\(error.localizedDescription)")
        }
        return SwapResult(succeeded: true, issue: nil)
    }

    /// 回滚：backup ↔ 当前。
    static func rollback(distDirectory: URL) -> SwapResult {
        let fileManager = FileManager.default
        let activeURL = distDirectory.appending(path: SelfBuildModels.activeBundleName)
        let backupURL = distDirectory.appending(path: SelfBuildModels.backupBundleName)
        let stagingURL = distDirectory.appending(path: "\(SelfBuildModels.backupBundleName).staging")
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
}
