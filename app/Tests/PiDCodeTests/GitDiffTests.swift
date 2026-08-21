import SwiftUI
import XCTest
@testable import PiDCode

/// 0.0.11 只读 Exact Git Diff：解析器、真实临时仓库分流与渲染冒烟。
final class GitDiffTests: XCTestCase {
    func testParserReadsMultiHunkDiffWithLineNumbers() {
        let fixture = """
        diff --git a/a.swift b/a.swift
        index 111..222 100644
        --- a/a.swift
        +++ b/a.swift
        @@ -1,4 +1,5 @@ 文件头部
         line1
        -line2
        +line2-new
        +line2b
         line3
        @@ -10,2 +11,2 @@
        -old
        +new
         keep
        """
        let diff = UnifiedDiffParser.parseFileDiff(fixture, path: "a.swift")

        XCTAssertFalse(diff.isBinary)
        XCTAssertFalse(diff.isTruncated)
        XCTAssertEqual(diff.hunks.count, 2)
        XCTAssertEqual(diff.additions, 3)
        XCTAssertEqual(diff.deletions, 2)
        XCTAssertEqual(diff.hunks[0].sectionHeading, "文件头部")
        let removed = diff.hunks[0].lines.first { $0.kind == .removed }
        XCTAssertEqual(removed?.oldLineNumber, 2)
        let added = diff.hunks[0].lines.first { $0.kind == .added }
        XCTAssertEqual(added?.newLineNumber, 2)
        XCTAssertEqual(diff.hunks[1].oldStart, 10)
        XCTAssertEqual(diff.hunks[1].newStart, 11)
    }

    func testParserMarksBinaryAndTruncatesOversizedDiffs() {
        let binary = UnifiedDiffParser.parseFileDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n", path: "x")
        XCTAssertTrue(binary.isBinary)

        var lines = ["diff --git a/big b/big", "--- a/big", "+++ b/big", "@@ -1,1 +1,3100 @@"]
        for index in 1...3_100 { lines.append("+line\(index)") }
        lines.append("@@ -5,1 +6,1 @@")
        lines.append("+second-hunk-line")
        let truncated = UnifiedDiffParser.parseFileDiff(lines.joined(separator: "\n"), path: "big")
        XCTAssertTrue(truncated.isTruncated)
        XCTAssertEqual(truncated.totalHunks, 2)
        XCTAssertEqual(truncated.hunks.count, 1, "超出阈值的后续 hunk 必须被丢弃")
        XCTAssertLessThanOrEqual(truncated.hunks.flatMap(\.lines).count, UnifiedDiffParser.maxDiffLines)
    }

    func testReaderSplitsStagedAndUnstagedInRealRepository() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-gitdiff-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        func git(_ arguments: [String]) throws {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", root.path] + arguments
            process.environment = ["PATH": "/usr/bin:/bin", "HOME": root.path, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "LC_ALL": "C"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, "git \(arguments) failed")
        }

        let file = root.appending(path: "a.txt")
        try Data("one\ntwo\n".utf8).write(to: file)
        try git(["init", "--initial-branch=main"])
        try git(["add", "."])
        try git(["commit", "-m", "init"])

        // staged：two -> two-staged
        try Data("one\ntwo-staged\n".utf8).write(to: file)
        try git(["add", "."])
        // unstaged：再追加一行
        try Data("one\ntwo-staged\nthree\n".utf8).write(to: file)

        let result = await GitDiffReader.fileDiff(repoRoot: root.path, path: "a.txt")

        let staged = try XCTUnwrap(result.staged)
        XCTAssertEqual(staged.additions, 1)
        XCTAssertEqual(staged.deletions, 1)
        XCTAssertNil(result.failure)
        let unstaged = try XCTUnwrap(result.unstaged)
        XCTAssertEqual(unstaged.additions, 1)
        XCTAssertEqual(unstaged.deletions, 0)
        XCTAssertTrue(unstaged.hunks[0].lines.contains { $0.text == "three" })
        XCTAssertFalse(staged.hunks.flatMap(\.lines).contains { $0.text == "three" }, "staged 不得混入未暂存内容")
    }

    @MainActor
    func testDiffSectionRendersWithHunks() {
        let diff = UnifiedDiffParser.parseFileDiff("""
        --- a/a.swift
        +++ b/a.swift
        @@ -1,3 +1,4 @@
         keep
        -old
        +new
        +extra
        """, path: "a.swift")

        let host = NSHostingView(
            rootView: GitDiffSection(title: "未暂存", diff: diff)
                .environment(AppModel())
                .frame(width: 460, height: 320)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero)
    }
}
