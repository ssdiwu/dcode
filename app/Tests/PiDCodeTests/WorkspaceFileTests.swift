import Foundation
import XCTest
@testable import PiDCode

final class WorkspaceFileTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        let directory = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true
        )
            .appendingPathComponent(".build", isDirectory: true)
            .appendingPathComponent("DCodeWorkspaceFileTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        temporaryDirectory = directory
    }

    override func tearDownWithError() throws {
        if let temporaryDirectory {
            try? FileManager.default.removeItem(at: temporaryDirectory)
        }
        temporaryDirectory = nil
    }

    func testReaderLoadsUTF8TextInsideRegisteredRoot() async throws {
        let source = temporaryDirectory.appendingPathComponent("Source", isDirectory: true)
        let nested = source.appendingPathComponent("Sources", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let file = nested.appendingPathComponent("App.swift")
        try Data("第一行\nsecond line\n".utf8).write(to: file)
        let loadedAt = Date(timeIntervalSince1970: 123)

        let snapshot = try await WorkspaceFileReader.read(
            path: file.path,
            sourceFolderPath: source.path,
            now: { loadedAt }
        )

        XCTAssertEqual(snapshot.path, file.path)
        XCTAssertEqual(snapshot.sourceFolderPath, source.path)
        XCTAssertEqual(snapshot.relativePath, "Sources/App.swift")
        XCTAssertEqual(snapshot.text, "第一行\nsecond line\n")
        XCTAssertEqual(snapshot.byteCount, Data("第一行\nsecond line\n".utf8).count)
        XCTAssertEqual(snapshot.loadedAt, loadedAt)
    }

    func testReaderRejectsOutsideSymlinkBinaryOversizedAndDirectoryTargets() async throws {
        let source = temporaryDirectory.appendingPathComponent("Source", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let outside = temporaryDirectory.appendingPathComponent("outside.txt")
        try Data("outside".utf8).write(to: outside)
        await assertReaderError(
            path: outside.path,
            root: source.path,
            equals: .outsideSourceFolder
        )

        let link = source.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        await assertReaderError(path: link.path, root: source.path, equals: .symbolicLink)

        let outsideDirectory = temporaryDirectory.appendingPathComponent("Outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outsideDirectory, withIntermediateDirectories: true)
        let nestedOutside = outsideDirectory.appendingPathComponent("nested.txt")
        try Data("outside nested".utf8).write(to: nestedOutside)
        let directoryLink = source.appendingPathComponent("linked-directory", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: directoryLink, withDestinationURL: outsideDirectory)
        await assertReaderError(
            path: directoryLink.appendingPathComponent("nested.txt").path,
            root: source.path,
            equals: .symbolicLink
        )

        let binary = source.appendingPathComponent("binary.dat")
        try Data([0x41, 0x00, 0x42]).write(to: binary)
        await assertReaderError(path: binary.path, root: source.path, equals: .binaryFile)

        let oversized = source.appendingPathComponent("oversized.txt")
        try Data(repeating: 0x41, count: WorkspaceFileReader.maximumBytes + 1).write(to: oversized)
        await assertReaderError(
            path: oversized.path,
            root: source.path,
            equals: .fileTooLarge(maximumBytes: WorkspaceFileReader.maximumBytes)
        )

        await assertReaderError(path: source.path, root: source.path, equals: .notRegularFile)
    }

    func testWorkspaceLinksKeepWebTargetsAndRewriteOnlySafeLocalShapes() throws {
        let web = try XCTUnwrap(URL(string: "https://example.com/reference"))
        XCTAssertEqual(WorkspaceFileLink.presentationURL(for: web), web)

        let file = try XCTUnwrap(URL(string: "file:///tmp/D%20Code/App.swift#L42"))
        let fileTarget = try XCTUnwrap(
            WorkspaceFileLink.presentationURL(for: file).flatMap(WorkspaceFileLink.decode)
        )
        XCTAssertEqual(fileTarget, .init(path: "/tmp/D Code/App.swift", line: 42))

        let relativeHash = try XCTUnwrap(URL(string: "Sources/App.swift#L7"))
        let relativeHashTarget = try XCTUnwrap(
            WorkspaceFileLink.presentationURL(for: relativeHash).flatMap(WorkspaceFileLink.decode)
        )
        XCTAssertEqual(relativeHashTarget, .init(path: "Sources/App.swift", line: 7))

        let relativeColon = try XCTUnwrap(URL(string: "Sources/App.swift:18"))
        let relativeColonTarget = try XCTUnwrap(
            WorkspaceFileLink.presentationURL(for: relativeColon).flatMap(WorkspaceFileLink.decode)
        )
        XCTAssertEqual(relativeColonTarget, .init(path: "Sources/App.swift", line: 18))

        XCTAssertNil(WorkspaceFileLink.presentationURL(for: try XCTUnwrap(URL(string: "javascript:alert(1)"))))
        XCTAssertNil(WorkspaceFileLink.presentationURL(for: try XCTUnwrap(URL(string: "ftp:path:12"))))
    }

    func testClosingSelectedTabUsesRightThenLeftThenConversation() {
        let tabs = [tab("/root/a.swift"), tab("/root/b.swift"), tab("/root/c.swift")]
        XCTAssertEqual(
            WorkspaceTabNavigation.selectionAfterClosing(
                path: "/root/b.swift",
                tabs: tabs,
                current: .file("/root/b.swift")
            ),
            .file("/root/c.swift")
        )
        XCTAssertEqual(
            WorkspaceTabNavigation.selectionAfterClosing(
                path: "/root/c.swift",
                tabs: tabs,
                current: .file("/root/c.swift")
            ),
            .file("/root/b.swift")
        )
        XCTAssertEqual(
            WorkspaceTabNavigation.selectionAfterClosing(
                path: "/root/a.swift",
                tabs: [tabs[0]],
                current: .file("/root/a.swift")
            ),
            .conversation
        )
        XCTAssertEqual(
            WorkspaceTabNavigation.selectionAfterClosing(
                path: "/root/a.swift",
                tabs: tabs,
                current: .file("/root/c.swift")
            ),
            .file("/root/c.swift")
        )
    }

    func testFileTabStripAppearsOnlyWhenAFileIsOpen() {
        XCTAssertFalse(WorkspaceTabNavigation.showsFileTabStrip(fileCount: 0))
        XCTAssertTrue(WorkspaceTabNavigation.showsFileTabStrip(fileCount: 1))
        XCTAssertTrue(WorkspaceTabNavigation.showsFileTabStrip(fileCount: 3))
    }

    func testAuthorizationUsesOnlyRegisteredAndMostSpecificSourceFolder() throws {
        let root = temporaryDirectory.appendingPathComponent("Root", isDirectory: true)
        let nested = root.appendingPathComponent("Nested", isDirectory: true)
        let file = nested.appendingPathComponent("file.txt")
        let projects = [
            DCodeProject(name: "Root", sourceFolders: [SourceFolder(path: root.path)]),
            DCodeProject(name: "Nested", sourceFolders: [SourceFolder(path: nested.path)]),
        ]

        XCTAssertEqual(
            WorkspaceFileAuthorization.registeredSourceFolder(
                containing: file.path,
                projects: projects
            )?.path,
            nested.path
        )
        XCTAssertNil(
            WorkspaceFileAuthorization.registeredSourceFolder(
                containing: temporaryDirectory.appendingPathComponent("other.txt").path,
                projects: projects
            )
        )
    }

    @MainActor
    func testAppModelDeduplicatesTabsAndRevokesRemovedProjectAuthorization() async throws {
        let source = temporaryDirectory.appendingPathComponent("Source", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let file = source.appendingPathComponent("README.md")
        try Data("original\n".utf8).write(to: file)
        let project = DCodeProject(name: "D Code", sourceFolders: [SourceFolder(path: source.path)])
        let projectStore = ProjectStore(
            fileURL: temporaryDirectory.appendingPathComponent("projects.json")
        )
        try await projectStore.save([project])
        let model = AppModel(
            projectStore: projectStore,
            sessionDraftStore: SessionDraftStore(
                fileURL: temporaryDirectory.appendingPathComponent("drafts.json")
            ),
            sessionArchiveStore: SessionArchiveStore(
                fileURL: temporaryDirectory.appendingPathComponent("archives.json")
            ),
            sessionPinStore: SessionPinStore(
                fileURL: temporaryDirectory.appendingPathComponent("pins.json")
            ),
            sessionChangeStore: SessionChangeStore(
                fileURL: temporaryDirectory.appendingPathComponent("changes.json")
            )
        )
        await model.loadProjects()

        await model.openWorkspaceFile(path: file.path, sourceFolderPath: source.path, line: 2)
        await model.openWorkspaceFile(path: file.path, sourceFolderPath: source.path, line: 7)

        XCTAssertEqual(model.workspaceFileTabs.count, 1)
        XCTAssertEqual(model.workspaceFileTabs[0].requestedLine, 7)
        XCTAssertEqual(model.workspaceFileTabs[0].snapshot?.text, "original\n")
        XCTAssertEqual(model.workspaceTabSelection, .file(file.path))

        try await model.deleteProject(project.id)

        XCTAssertFalse(model.workspaceFileTabs[0].authorizationAvailable)
        XCTAssertEqual(model.workspaceFileTabs[0].snapshot?.text, "original\n")
        try Data("changed\n".utf8).write(to: file)
        await model.retryWorkspaceFile(path: file.path)
        XCTAssertEqual(model.workspaceFileTabs[0].snapshot?.text, "original\n")

        await model.openWorkspaceFile(path: file.path, sourceFolderPath: source.path)
        XCTAssertEqual(model.workspaceFileTabs.count, 1)
        XCTAssertEqual(model.issue?.title, "无法打开文件")
    }

    private func tab(_ path: String) -> WorkspaceFileTab {
        WorkspaceFileTab(
            path: path,
            sourceFolderPath: "/root",
            requestedLine: nil,
            snapshot: nil,
            errorMessage: nil,
            isLoading: false,
            authorizationAvailable: true
        )
    }

    private func assertReaderError(
        path: String,
        root: String,
        equals expected: WorkspaceFileReaderError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await WorkspaceFileReader.read(path: path, sourceFolderPath: root)
            XCTFail("Expected WorkspaceFileReader to reject \(path)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? WorkspaceFileReaderError, expected, file: file, line: line)
        }
    }
}
