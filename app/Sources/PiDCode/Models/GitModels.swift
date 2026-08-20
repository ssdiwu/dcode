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
    enum CommandResult {
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

    static func runGitPublic(_ arguments: [String]) -> CommandResult {
        runGit(arguments)
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

// MARK: - Exact Git Diff（0.0.11，只读）

enum GitDiffLineKind: Hashable, Sendable {
    case context
    case added
    case removed
}

struct GitDiffLine: Hashable, Identifiable, Sendable {
    let kind: GitDiffLineKind
    let oldLineNumber: Int?
    let newLineNumber: Int?
    let text: String

    var id: String { "\(oldLineNumber.map(String.init) ?? "n")-\(newLineNumber.map(String.init) ?? "n")-\(text)" }
}

struct GitDiffHunk: Hashable, Identifiable, Sendable {
    let oldStart: Int
    let oldCount: Int
    let newStart: Int
    let newCount: Int
    let sectionHeading: String
    let lines: [GitDiffLine]

    var id: String { "\(oldStart).\(newStart).\(lines.count)" }
}

struct GitFileDiff: Hashable, Sendable {
    let path: String
    let hunks: [GitDiffHunk]
    let isBinary: Bool
    let isTruncated: Bool
    let totalHunks: Int

    var additions: Int { hunks.flatMap(\.lines).filter { $0.kind == .added }.count }
    var deletions: Int { hunks.flatMap(\.lines).filter { $0.kind == .removed }.count }
}

struct GitFileDiffResult: Sendable {
    let staged: GitFileDiff?
    let unstaged: GitFileDiff?
    let failure: String?

    var isEmpty: Bool { staged == nil && unstaged == nil && failure == nil }
}

enum UnifiedDiffParser {
    static let maxDiffBytes = 512 * 1_024
    static let maxDiffLines = 3_000

    static func parseFileDiff(_ output: String, path: String) -> GitFileDiff {
        if output.contains("Binary files") && output.contains("differ") {
            return GitFileDiff(path: path, hunks: [], isBinary: true, isTruncated: false, totalHunks: 0)
        }
        var hunks: [GitDiffHunk] = []
        var currentLines: [GitDiffLine] = []
        var currentHeader: (Int, Int, Int, Int, String)?
        var totalHunks = 0
        var truncated = false
        var oldLine = 0
        var newLine = 0
        var parsedLines = 0

        func flushHunk() {
            guard let header = currentHeader else { return }
            hunks.append(GitDiffHunk(
                oldStart: header.0,
                oldCount: header.1,
                newStart: header.2,
                newCount: header.3,
                sectionHeading: header.4,
                lines: currentLines
            ))
            currentLines = []
            currentHeader = nil
        }

        for rawLine in output.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            if line.hasPrefix("@@") {
                flushHunk()
                totalHunks += 1
                if parsedLines > maxDiffLines {
                    truncated = true
                    continue
                }
                currentHeader = parseHunkHeader(line) ?? (0, 0, 0, 0, "")
                oldLine = currentHeader!.0
                newLine = currentHeader!.2
                continue
            }
            guard currentHeader != nil else { continue }
            if truncated { continue }
            parsedLines += 1
            if parsedLines > maxDiffLines {
                truncated = true
                continue
            }
            if line.hasPrefix("+") {
                currentLines.append(GitDiffLine(kind: .added, oldLineNumber: nil, newLineNumber: newLine, text: String(line.dropFirst())))
                newLine += 1
            } else if line.hasPrefix("-") {
                currentLines.append(GitDiffLine(kind: .removed, oldLineNumber: oldLine, newLineNumber: nil, text: String(line.dropFirst())))
                oldLine += 1
            } else if line.hasPrefix(" ") || line.isEmpty {
                currentLines.append(GitDiffLine(kind: .context, oldLineNumber: oldLine, newLineNumber: newLine, text: String(line.dropFirst())))
                oldLine += 1
                newLine += 1
            } else if line.hasPrefix("\\") {
                // "\ No newline at end of file" —— 附属标记，不作为差异行
            }
        }
        flushHunk()
        if truncated {
            // 截断时丢弃未完整解析的尾部 hunk，只保留已完整收集的部分
            hunks = Array(hunks.prefix(while: { _ in true }).prefix(hunks.count))
        }
        return GitFileDiff(path: path, hunks: hunks, isBinary: false, isTruncated: truncated, totalHunks: totalHunks)
    }

    static func parseHunkHeader(_ line: String) -> (Int, Int, Int, Int, String)? {
        // @@ -oldStart,oldCount +newStart,newCount @@ section
        guard let oldRange = line.range(of: #"-(\d+)(?:,(\d+))?"#, options: .regularExpression),
              let newRange = line.range(of: #"\+(\d+)(?:,(\d+))?"#, options: .regularExpression)
        else { return nil }
        let oldPart = line[oldRange].dropFirst()
        let newPart = line[newRange].dropFirst()
        let oldNumbers = oldPart.split(separator: ",").compactMap { Int($0) }
        let newNumbers = newPart.split(separator: ",").compactMap { Int($0) }
        guard oldNumbers.first != nil, newNumbers.first != nil else { return nil }
        let components = line.split(separator: "@@", omittingEmptySubsequences: false)
        let heading = components.count > 2
            ? components.dropFirst(2).joined(separator: "@@").trimmingCharacters(in: .whitespaces)
            : ""
        return (
            oldNumbers[0],
            oldNumbers.count > 1 ? oldNumbers[1] : 1,
            newNumbers[0],
            newNumbers.count > 1 ? newNumbers[1] : 1,
            heading
        )
    }
}

enum GitDiffReader {
    /// 只读读取单个文件相对 HEAD 的 staged / unstaged 差异。
    static func fileDiff(repoRoot: String, path: String) async -> GitFileDiffResult {
        await Task.detached(priority: .utility) {
            let unstagedResult = GitChangesReader.runGitPublic(["-C", repoRoot, "diff", "--", path])
            let stagedResult = GitChangesReader.runGitPublic(["-C", repoRoot, "diff", "--cached", "--", path])
            var failure: String?
            var unstaged: GitFileDiff?
            var staged: GitFileDiff?
            switch unstagedResult {
            case let .success(data):
                let text = String(decoding: data.prefix(UnifiedDiffParser.maxDiffBytes), as: UTF8.self)
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let diff = UnifiedDiffParser.parseFileDiff(text, path: path)
                    if !diff.hunks.isEmpty || diff.isBinary { unstaged = diff }
                }
            case let .failure(message):
                failure = message
            }
            switch stagedResult {
            case let .success(data):
                let text = String(decoding: data.prefix(UnifiedDiffParser.maxDiffBytes), as: UTF8.self)
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let diff = UnifiedDiffParser.parseFileDiff(text, path: path)
                    if !diff.hunks.isEmpty || diff.isBinary { staged = diff }
                }
            case let .failure(message):
                failure = failure ?? message
            }
            return GitFileDiffResult(staged: staged, unstaged: unstaged, failure: failure)
        }.value
    }
}
