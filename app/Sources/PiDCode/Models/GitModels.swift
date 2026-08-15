import Foundation

struct GitChange: Hashable, Identifiable, Sendable {
    let status: String
    let path: String
    let originalPath: String?

    var id: String { "\(status):\(originalPath ?? ""):\(path)" }
}

enum GitRepositoryState: Hashable, Sendable {
    case ready(branch: String, changes: [GitChange])
    case notRepository
    case failed(String)
}

enum GitBranchLookupState: Hashable, Sendable {
    case idle
    case loading
    case ready(String)
    case notRepository
    case failed
}

struct GitRepositorySnapshot: Hashable, Identifiable, Sendable {
    let rootPath: String
    let sourceFolderNames: [String]
    let state: GitRepositoryState

    var id: String { rootPath }
}

enum GitChangesReader {
    private enum CommandResult {
        case success(Data)
        case failure(String)
    }

    static func read(sourceFolders: [SourceFolder]) async -> [GitRepositorySnapshot] {
        let inputs = sourceFolders.map { ($0.path, $0.displayName) }
        return await Task.detached(priority: .utility) {
            readSynchronously(inputs: inputs)
        }.value
    }

    static func readBranch(at directoryPath: String) async -> GitBranchLookupState {
        await Task.detached(priority: .utility) {
            switch runGit(["-c", "core.fsmonitor=false", "-C", directoryPath, "branch", "--show-current"]) {
            case let .success(data):
                let branch = removingLineEnding(String(decoding: data, as: UTF8.self))
                return .ready(branch.isEmpty ? "游离 HEAD" : branch)
            case let .failure(message):
                return message.localizedCaseInsensitiveContains("not a git repository")
                    ? .notRepository
                    : .failed
            }
        }.value
    }

    static func parsePorcelainV1(_ data: Data) -> [GitChange] {
        let records = data.split(separator: 0, omittingEmptySubsequences: true).map { Data($0) }
        var changes: [GitChange] = []
        var index = 0
        while index < records.count {
            let record = String(decoding: records[index], as: UTF8.self)
            index += 1
            guard record.utf8.count >= 3 else { continue }
            let status = String(record.prefix(2))
            let path = String(record.dropFirst(3))
            let isRenameOrCopy = status.contains("R") || status.contains("C")
            let originalPath: String?
            if isRenameOrCopy, index < records.count {
                originalPath = String(decoding: records[index], as: UTF8.self)
                index += 1
            } else {
                originalPath = nil
            }
            changes.append(GitChange(status: status, path: path, originalPath: originalPath))
        }
        return changes
    }

    private static func readSynchronously(inputs: [(path: String, name: String)]) -> [GitRepositorySnapshot] {
        var roots: [String: [String]] = [:]
        var order: [String] = []
        var failures: [GitRepositorySnapshot] = []

        for input in inputs {
            switch runGit(["-c", "core.fsmonitor=false", "-C", input.path, "rev-parse", "--show-toplevel"]) {
            case let .success(outputData):
                let output = String(decoding: outputData, as: UTF8.self)
                let root = URL(fileURLWithPath: removingLineEnding(output))
                    .standardizedFileURL.resolvingSymlinksInPath().path
                if roots[root] == nil { order.append(root) }
                roots[root, default: []].append(input.name)
            case let .failure(message):
                let isNotRepository = message.localizedCaseInsensitiveContains("not a git repository")
                failures.append(GitRepositorySnapshot(
                    rootPath: input.path,
                    sourceFolderNames: [input.name],
                    state: isNotRepository ? .notRepository : .failed(message)
                ))
            }
        }

        let repositories = order.map { root -> GitRepositorySnapshot in
            let branchResult = runGit(["-c", "core.fsmonitor=false", "-C", root, "branch", "--show-current"])
            let statusResult = runGit(["-c", "core.fsmonitor=false", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"])
            switch (branchResult, statusResult) {
            case let (.success(branchData), .success(statusData)):
                let branch = removingLineEnding(String(decoding: branchData, as: UTF8.self))
                return GitRepositorySnapshot(
                    rootPath: root,
                    sourceFolderNames: roots[root, default: []],
                    state: .ready(
                        branch: branch.isEmpty ? "游离 HEAD" : branch,
                        changes: parsePorcelainV1(statusData)
                    )
                )
            case let (.failure(message), _), let (_, .failure(message)):
                return GitRepositorySnapshot(
                    rootPath: root,
                    sourceFolderNames: roots[root, default: []],
                    state: .failed(message)
                )
            }
        }
        return repositories + failures
    }

    private static func removingLineEnding(_ value: String) -> String {
        if value.hasSuffix("\r\n") { return String(value.dropLast(2)) }
        if value.hasSuffix("\n") { return String(value.dropLast()) }
        return value
    }

    private static func runGit(_ arguments: [String]) -> CommandResult {
        let process = Process()
        let captureDirectory = FileManager.default.temporaryDirectory
            .appending(path: "dcode-git-\(UUID().uuidString)", directoryHint: .isDirectory)
        let outputURL = captureDirectory.appending(path: "stdout")
        let errorURL = captureDirectory.appending(path: "stderr")
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["LC_ALL"] = "C"
        process.environment = environment
        do {
            try FileManager.default.createDirectory(at: captureDirectory, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: outputURL.path, contents: nil)
            FileManager.default.createFile(atPath: errorURL.path, contents: nil)
            let outputHandle = try FileHandle(forWritingTo: outputURL)
            let errorHandle = try FileHandle(forWritingTo: errorURL)
            process.standardOutput = outputHandle
            process.standardError = errorHandle
            try process.run()
            process.waitUntilExit()
            try outputHandle.close()
            try errorHandle.close()
            let outputData = try Data(contentsOf: outputURL)
            let errorData = try Data(contentsOf: errorURL)
            try? FileManager.default.removeItem(at: captureDirectory)
            if process.terminationStatus == 0 { return .success(outputData) }
            let message = String(decoding: errorData, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure(message.isEmpty ? "Git 查询失败（状态 \(process.terminationStatus)）" : message)
        } catch {
            try? FileManager.default.removeItem(at: captureDirectory)
            return .failure(error.localizedDescription)
        }
    }
}

actor GitBranchCache {
    static let shared = GitBranchCache()

    private struct Entry {
        let state: GitBranchLookupState
        let loadedAt: Date
    }

    private let freshness: TimeInterval = 5
    private var entries: [String: Entry] = [:]
    private var inFlight: [String: Task<GitBranchLookupState, Never>] = [:]

    func read(at directoryPath: String) async -> GitBranchLookupState {
        let canonicalPath = URL(fileURLWithPath: directoryPath, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
        if let entry = entries[canonicalPath], Date().timeIntervalSince(entry.loadedAt) < freshness {
            return entry.state
        }
        if let task = inFlight[canonicalPath] { return await task.value }

        let task = Task { await GitChangesReader.readBranch(at: canonicalPath) }
        inFlight[canonicalPath] = task
        let state = await task.value
        inFlight.removeValue(forKey: canonicalPath)
        entries[canonicalPath] = Entry(state: state, loadedAt: Date())
        return state
    }
}
