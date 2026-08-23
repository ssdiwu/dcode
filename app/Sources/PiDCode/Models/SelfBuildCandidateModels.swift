import CryptoKit
import Foundation

struct SelfBuildSourceRootInfo: Equatable, Sendable {
    let rootURL: URL
    let issue: String?

    var isValid: Bool { issue == nil }
}

enum SelfBuildSourceRootResolver {
    private static let requiredRelativePaths = [
        "Package.swift",
        "app/build.sh",
        "host/package.json",
    ]

    static func validate(_ candidate: URL) -> SelfBuildSourceRootInfo {
        let root = candidate.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory = ObjCBool(false)
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return SelfBuildSourceRootInfo(rootURL: root, issue: "源码目录不存在或不可访问")
        }
        let missing = requiredRelativePaths.filter {
            !FileManager.default.fileExists(atPath: root.appending(path: $0).path)
        }
        guard missing.isEmpty else {
            return SelfBuildSourceRootInfo(
                rootURL: root,
                issue: "不是完整的 D Code checkout，缺少：\(missing.joined(separator: "、"))"
            )
        }
        return SelfBuildSourceRootInfo(rootURL: root, issue: nil)
    }

    static func discover(
        configuredPath: String?,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleURL: URL = Bundle.main.bundleURL,
        currentDirectoryURL: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    ) -> SelfBuildSourceRootInfo? {
        var candidates: [URL] = []
        if let configuredPath, !configuredPath.isEmpty {
            candidates.append(URL(fileURLWithPath: configuredPath, isDirectory: true))
        }
        if let override = environment["D_CODE_SELF_BUILD_ROOT"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override, isDirectory: true))
        }
        candidates.append(contentsOf: ancestors(of: bundleURL))
        candidates.append(contentsOf: ancestors(of: currentDirectoryURL))

        var seen = Set<String>()
        for candidate in candidates {
            let info = validate(candidate)
            guard seen.insert(info.rootURL.path).inserted else { continue }
            if info.isValid { return info }
        }
        return nil
    }

    private static func ancestors(of url: URL) -> [URL] {
        var result: [URL] = []
        var cursor = (url.hasDirectoryPath ? url : url.deletingLastPathComponent()).standardizedFileURL
        while true {
            result.append(cursor)
            if cursor.pathComponents.count <= 1 { break }
            let parent = cursor.deletingLastPathComponent()
            if parent.path.isEmpty || parent.path == cursor.path { break }
            cursor = parent
        }
        return result
    }
}

struct SelfBuildSourceSnapshot: Codable, Equatable, Sendable {
    let revision: String
    let dirty: Bool
    let changedFileCount: Int
    let digest: String
}

enum SelfBuildSourceSnapshotError: LocalizedError, Equatable {
    case gitCommandFailed(String)
    case unreadableUntrackedFile(String)

    var errorDescription: String? {
        switch self {
        case let .gitCommandFailed(message):
            "无法读取源码 Git 快照：\(message)"
        case let .unreadableUntrackedFile(path):
            "无法读取未跟踪源码文件以建立候选 digest：\(path)"
        }
    }
}

enum SelfBuildSourceSnapshotter {
    static func capture(rootURL: URL) throws -> SelfBuildSourceSnapshot {
        let revisionData = try git(["rev-parse", "HEAD"], rootURL: rootURL)
        let statusData = try git(["status", "--porcelain=v1"], rootURL: rootURL)
        let diffData = try git(["diff", "--binary", "HEAD"], rootURL: rootURL)
        let untrackedData = try git(["ls-files", "--others", "--exclude-standard", "-z"], rootURL: rootURL)

        let revision = String(decoding: revisionData, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let statusText = String(decoding: statusData, as: UTF8.self)
        let changedFileCount = statusText.split(whereSeparator: \.isNewline).count

        var hasher = SHA256()
        hasher.update(data: Data("revision\0\(revision)\0".utf8))
        hasher.update(data: statusData)
        hasher.update(data: diffData)

        let untrackedPaths = untrackedData.split(separator: 0).map { String(decoding: $0, as: UTF8.self) }
        for relativePath in untrackedPaths.sorted() {
            let fileURL = rootURL.appending(path: relativePath).standardizedFileURL
            guard isContained(fileURL, by: rootURL) else {
                throw SelfBuildSourceSnapshotError.unreadableUntrackedFile(relativePath)
            }
            hasher.update(data: Data("untracked\0\(relativePath)\0".utf8))
            let values = try? fileURL.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
            if values?.isSymbolicLink == true {
                let destination = try FileManager.default.destinationOfSymbolicLink(atPath: fileURL.path)
                hasher.update(data: Data("symlink\0\(destination)".utf8))
            } else if values?.isRegularFile == true {
                guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
                    throw SelfBuildSourceSnapshotError.unreadableUntrackedFile(relativePath)
                }
                do {
                    while true {
                        let data = try handle.read(upToCount: 1_048_576) ?? Data()
                        if data.isEmpty { break }
                        hasher.update(data: data)
                    }
                    try handle.close()
                } catch {
                    try? handle.close()
                    throw SelfBuildSourceSnapshotError.unreadableUntrackedFile(relativePath)
                }
            }
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return SelfBuildSourceSnapshot(
            revision: revision,
            dirty: !statusData.isEmpty,
            changedFileCount: changedFileCount,
            digest: digest
        )
    }

    private static func git(_ arguments: [String], rootURL: URL) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", rootURL.path] + arguments
        process.environment = ProcessInfo.processInfo.environment.merging([
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        ]) { _, new in new }
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        do {
            try process.run()
            let outputData = output.fileHandleForReading.readDataToEndOfFile()
            let errorData = error.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                throw SelfBuildSourceSnapshotError.gitCommandFailed(
                    String(decoding: errorData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                )
            }
            return outputData
        } catch let error as SelfBuildSourceSnapshotError {
            throw error
        } catch {
            throw SelfBuildSourceSnapshotError.gitCommandFailed(error.localizedDescription)
        }
    }

    private static func isContained(_ candidate: URL, by root: URL) -> Bool {
        let rootComponents = root.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        let candidateComponents = candidate.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        return candidateComponents.count >= rootComponents.count
            && Array(candidateComponents.prefix(rootComponents.count)) == rootComponents
    }
}

struct SelfBuildCommandResult: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let command: String
    let succeeded: Bool
    let exitCode: Int32?
    let durationMs: Int
    let outputTail: [String]
}

struct SelfBuildVerificationManifestRecord: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let command: String
    let succeeded: Bool
    let exitCode: Int32?
    let durationMs: Int

    init(_ result: SelfBuildCommandResult) {
        id = result.id
        label = result.label
        command = result.command
        succeeded = result.succeeded
        exitCode = result.exitCode
        durationMs = result.durationMs
    }
}

struct SelfBuildCommandSpec: Equatable, Sendable {
    let id: String
    let label: String
    let executableURL: URL
    let arguments: [String]
    let command: String
    let workingDirectory: URL
    let environment: [String: String]

    init(
        id: String,
        label: String,
        executableURL: URL,
        arguments: [String],
        command: String,
        workingDirectory: URL,
        environment: [String: String] = [:]
    ) {
        self.id = id
        self.label = label
        self.executableURL = executableURL
        self.arguments = arguments
        self.command = command
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

enum SelfBuildCommandRunner {
    static let tailLineLimit = 200

    static func run(_ spec: SelfBuildCommandSpec) async -> SelfBuildCommandResult {
        final class ResultBox: @unchecked Sendable {
            let lock = NSLock()
            var lines: [String] = []
            var exitCode: Int32?
        }
        let box = ResultBox()
        let startedAt = Date()

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let process = Process()
            process.executableURL = spec.executableURL
            process.arguments = spec.arguments
            process.currentDirectoryURL = spec.workingDirectory
            var environment = ProcessInfo.processInfo.environment
            for (key, value) in spec.environment { environment[key] = value }
            process.environment = environment
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
                    box.lines.append(contentsOf: text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init))
                }
            }
            process.terminationHandler = { terminated in
                pipe.fileHandleForReading.readabilityHandler = nil
                box.lock.withLock { box.exitCode = terminated.terminationStatus }
                continuation.resume()
            }
            do {
                try process.run()
            } catch {
                box.lock.withLock {
                    box.lines.append("命令未能启动：\(error.localizedDescription)")
                    box.exitCode = nil
                }
                continuation.resume()
            }
        }

        let (lines, exitCode) = box.lock.withLock { (box.lines, box.exitCode) }
        return SelfBuildCommandResult(
            id: spec.id,
            label: spec.label,
            command: spec.command,
            succeeded: exitCode == 0,
            exitCode: exitCode,
            durationMs: max(0, Int(Date().timeIntervalSince(startedAt) * 1_000)),
            outputTail: Array(lines.suffix(tailLineLimit))
        )
    }
}

enum SelfBuildVerificationRunner {
    static func commandSpecs(
        rootURL: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [SelfBuildCommandSpec] {
        let home = environment["HOME"] ?? NSHomeDirectory()
        let nodeURL = URL(
            fileURLWithPath: environment["PI_DCODE_NODE_BIN"]
                ?? URL(fileURLWithPath: home, isDirectory: true)
                    .appending(path: ".hermes/node/bin/node").path
        )
        let nodeBinDirectory = nodeURL.deletingLastPathComponent()
        let npmURL = URL(
            fileURLWithPath: environment["PI_DCODE_NPM_BIN"]
                ?? nodeBinDirectory.appending(path: "npm").path
        )
        let basePath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let hostPath = "\(nodeBinDirectory.path):\(basePath)"
        return [
            SelfBuildCommandSpec(
                id: "swift-tests",
                label: "Swift 回归",
                executableURL: URL(fileURLWithPath: "/usr/bin/env"),
                arguments: ["swift", "test"],
                command: "swift test",
                workingDirectory: rootURL,
                environment: ["PATH": basePath]
            ),
            SelfBuildCommandSpec(
                id: "host-tests",
                label: "Host 回归",
                executableURL: npmURL,
                arguments: ["test"],
                command: "cd host && npm test",
                workingDirectory: rootURL.appending(path: "host", directoryHint: .isDirectory),
                environment: ["PATH": hostPath]
            ),
        ]
    }

    static func run(rootURL: URL) async -> [SelfBuildCommandResult] {
        let specs = commandSpecs(rootURL: rootURL)
        var results: [SelfBuildCommandResult] = []
        for spec in specs {
            let result = await SelfBuildCommandRunner.run(spec)
            results.append(result)
            if !result.succeeded { break }
        }
        return results
    }
}

struct SelfBuildCandidateManifest: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let resourceName = "self-build-manifest.json"

    let schemaVersion: Int
    let kind: String
    let generatedAt: String
    let sourceRevision: String
    let sourceDirty: Bool
    let changedFileCount: Int
    let sourceDigest: String
    let localOnly: Bool
    let verifications: [SelfBuildVerificationManifestRecord]

    init(snapshot: SelfBuildSourceSnapshot, verifications: [SelfBuildCommandResult], generatedAt: String = Date().ISO8601Format()) {
        schemaVersion = Self.currentVersion
        kind = "local-self-build-candidate"
        self.generatedAt = generatedAt
        sourceRevision = snapshot.revision
        sourceDirty = snapshot.dirty
        changedFileCount = snapshot.changedFileCount
        sourceDigest = snapshot.digest
        localOnly = true
        self.verifications = verifications.map(SelfBuildVerificationManifestRecord.init)
    }

    var isValid: Bool {
        let isHex: (String) -> Bool = { value in
            !value.isEmpty && value.unicodeScalars.allSatisfy {
                CharacterSet(charactersIn: "0123456789abcdef").contains($0)
            }
        }
        let expectedChecks = [
            (id: "swift-tests", command: "swift test"),
            (id: "host-tests", command: "cd host && npm test"),
        ]
        return schemaVersion == Self.currentVersion
            && kind == "local-self-build-candidate"
            && [40, 64].contains(sourceRevision.count)
            && isHex(sourceRevision)
            && sourceDigest.count == 64
            && isHex(sourceDigest)
            && changedFileCount >= 0
            && (sourceDirty ? changedFileCount > 0 : changedFileCount == 0)
            && !generatedAt.isEmpty
            && localOnly
            && verifications.count == expectedChecks.count
            && expectedChecks.allSatisfy { expected in
                verifications.contains {
                    $0.id == expected.id
                        && $0.command == expected.command
                        && $0.succeeded
                        && $0.exitCode == 0
                }
            }
    }

    static func load(from bundleURL: URL) -> SelfBuildCandidateManifest? {
        let url = bundleURL.appending(path: "Contents/Resources/\(resourceName)")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SelfBuildCandidateManifest.self, from: data)
    }
}
