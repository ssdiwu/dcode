import SwiftUI
import XCTest
@testable import PiDCode

/// 0.0.17 Markdown 编辑缓冲区与安全保存（ADR 0025）：Writer 原子性 / 冲突 /
/// 失败关闭用例 + AppModel 编辑流集成 + 文件视图渲染冒烟。
/// 全部使用真实临时目录与真实文件系统，不触碰用户数据。
@MainActor
final class WorkspaceFileEditingTests: XCTestCase {
    private var rootURL: URL!

    override func setUpWithError() throws {
        // 仿 WorkspaceFileTests：temporaryDirectory 在 /var 下（含符号链接组件），
        // 安全路径全程 O_NOFOLLOW 会拒绝；改用仓库 .build 下的真实路径。
        rootURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent(".build", isDirectory: true)
            .appendingPathComponent("DCodeWorkspaceEditing-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: rootURL)
    }

    private var root: String { rootURL.path }

    private func makeFile(
        _ name: String = "notes.md",
        content: String,
        permissions: Int = 0o644
    ) throws -> String {
        let url = rootURL.appending(path: name)
        try content.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: permissions],
            ofItemAtPath: url.path
        )
        return url.path
    }

    private func diskText(_ path: String) throws -> String {
        try String(contentsOfFile: path, encoding: .utf8)
    }

    private func temporaryFiles() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: root))?.filter {
            $0.contains(".dcode-")
        } ?? []
    }

    // MARK: - WorkspaceFileWriter

    func testWriterSavesAtomicallyAndKeepsPermissionsWithoutDebris() async throws {
        let path = try makeFile(content: "旧内容", permissions: 0o640)
        let base = try await WorkspaceFileReader.read(path: path, sourceFolderPath: root)

        let snapshot = try await WorkspaceFileWriter.save(
            path: path,
            sourceFolderPath: root,
            text: "# 新内容\n",
            expectedBaseDigest: base.contentDigest
        )

        XCTAssertEqual(try diskText(path), "# 新内容\n")
        XCTAssertEqual(snapshot.text, "# 新内容\n")
        XCTAssertEqual(snapshot.contentDigest, WorkspaceFileDigest.sha256Hex(of: Data("# 新内容\n".utf8)))
        XCTAssertEqual(snapshot.byteCount, "# 新内容\n".utf8.count)
        XCTAssertTrue(temporaryFiles().isEmpty, "保存后不得残留临时文件")
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual(
            (attributes[.posixPermissions] as? NSNumber)?.int16Value ?? 0,
            Int16(0o640),
            "原子替换保留原文件权限位"
        )
    }

    func testWriterRefusesConflictingSaveAndLeavesDiskUntouched() async throws {
        let path = try makeFile(content: "基准内容")
        let base = try await WorkspaceFileReader.read(path: path, sourceFolderPath: root)
        try "外部编辑".write(toFile: path, atomically: true, encoding: .utf8)

        do {
            _ = try await WorkspaceFileWriter.save(
                path: path,
                sourceFolderPath: root,
                text: "缓冲区内容",
                expectedBaseDigest: base.contentDigest
            )
            XCTFail("指纹不匹配必须拒绝")
        } catch let error as WorkspaceFileWriterError {
            XCTAssertEqual(error, .conflict)
        }
        XCTAssertEqual(try diskText(path), "外部编辑", "冲突保存零写入")
        XCTAssertTrue(temporaryFiles().isEmpty)
    }

    func testWriterOverwriteAfterExplicitResolution() async throws {
        let path = try makeFile(content: "基准内容")
        _ = try await WorkspaceFileReader.read(path: path, sourceFolderPath: root)
        try "外部编辑".write(toFile: path, atomically: true, encoding: .utf8)

        // 冲突三选之一：显式覆盖（nil 基准跳过比对，但仍不创建新文件）。
        let snapshot = try await WorkspaceFileWriter.save(
            path: path,
            sourceFolderPath: root,
            text: "覆盖后的缓冲区内容",
            expectedBaseDigest: nil
        )
        XCTAssertEqual(try diskText(path), "覆盖后的缓冲区内容")
        XCTAssertEqual(snapshot.contentDigest, WorkspaceFileDigest.sha256Hex(of: Data("覆盖后的缓冲区内容".utf8)))
    }

    func testWriterRefusesMissingFileWithoutCreatingIt() async throws {
        let missing = rootURL.appending(path: "gone.md").path
        do {
            _ = try await WorkspaceFileWriter.save(
                path: missing,
                sourceFolderPath: root,
                text: "内容",
                expectedBaseDigest: nil
            )
            XCTFail("文件不存在必须拒绝，不得借机创建")
        } catch let error as WorkspaceFileWriterError {
            XCTAssertEqual(error, .fileMissing)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing))
    }

    func testWriterRefusesPathOutsideAuthorizedRoot() async throws {
        let outside = FileManager.default.temporaryDirectory
            .appending(path: "outside-\(UUID().uuidString).md")
        try? "x".write(to: outside, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: outside) }

        do {
            _ = try await WorkspaceFileWriter.save(
                path: outside.path,
                sourceFolderPath: root,
                text: "越界",
                expectedBaseDigest: nil
            )
            XCTFail("授权根外必须拒绝")
        } catch let error as WorkspaceFileWriterError {
            XCTAssertEqual(error, .outsideSourceFolder)
        }
    }

    func testWriterRefusesSymbolicLinkTarget() async throws {
        let real = try makeFile("real.md", content: "真实文件")
        let alias = rootURL.appending(path: "alias.md").path
        try FileManager.default.createSymbolicLink(
            atPath: alias,
            withDestinationPath: URL(fileURLWithPath: real).lastPathComponent
        )

        do {
            _ = try await WorkspaceFileWriter.save(
                path: alias,
                sourceFolderPath: root,
                text: "通过符号链接写入",
                expectedBaseDigest: nil
            )
            XCTFail("符号链接必须拒绝写入")
        } catch let error as WorkspaceFileWriterError {
            XCTAssertEqual(error, .symbolicLink)
        }
        XCTAssertEqual(try diskText(real), "真实文件")
    }

    func testWriterRefusesOversizedPayload() async throws {
        let path = try makeFile(content: "小文件")
        let huge = String(repeating: "a", count: WorkspaceFileWriter.maximumBytes + 1)
        do {
            _ = try await WorkspaceFileWriter.save(
                path: path,
                sourceFolderPath: root,
                text: huge,
                expectedBaseDigest: nil
            )
            XCTFail("超过上限必须拒绝")
        } catch let error as WorkspaceFileWriterError {
            XCTAssertEqual(error, .fileTooLarge(maximumBytes: WorkspaceFileWriter.maximumBytes))
        }
    }

    // MARK: - AppModel 编辑流

    private func makeLoadedTab(path: String) async throws -> AppModel {
        let model = AppModel()
        // 登记 Source Folder，使“重新加载”路径的授权检查可以放行。
        model.projects = [DCodeProject(
            id: UUID(),
            name: "编辑测试项目",
            sourceFolders: [SourceFolder(path: root)]
        )]
        let snapshot = try await WorkspaceFileReader.read(path: path, sourceFolderPath: root)
        model.workspaceFileTabs = [WorkspaceFileTab(
            path: path,
            sourceFolderPath: root,
            requestedLine: nil,
            snapshot: snapshot,
            errorMessage: nil,
            isLoading: false,
            authorizationAvailable: true
        )]
        model.workspaceTabSelection = .file(path)
        return model
    }

    func testEditingFlowUpdatesSnapshotAndCleansAfterSave() async throws {
        let path = try makeFile(content: "初始")
        let model = try await makeLoadedTab(path: path)

        model.startEditingWorkspaceFile(path: path)
        XCTAssertNotNil(model.workspaceFileTabs[0].draft)
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isDirty, "从快照建立的缓冲区初始为 clean")

        model.updateWorkspaceFileDraft(path: path, text: "修改后")
        XCTAssertTrue(model.workspaceFileTabs[0].draft!.isDirty)
        XCTAssertTrue(model.canSaveSelectedWorkspaceFileDraft)

        let saved = await model.saveWorkspaceFileDraft(path: path)
        XCTAssertTrue(saved)
        XCTAssertEqual(try diskText(path), "修改后")
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isDirty, "保存成功后基准前移")
        XCTAssertEqual(model.workspaceFileTabs[0].snapshot?.text, "修改后")
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isConflicted)
    }

    func testConflictFlowRequiresExplicitResolution() async throws {
        let path = try makeFile(content: "基准")
        let model = try await makeLoadedTab(path: path)
        model.startEditingWorkspaceFile(path: path)
        model.updateWorkspaceFileDraft(path: path, text: "缓冲区版本")
        try "外部版本".write(toFile: path, atomically: true, encoding: .utf8)

        let first = await model.saveWorkspaceFileDraft(path: path)
        XCTAssertFalse(first)
        XCTAssertTrue(model.workspaceFileTabs[0].draft!.isConflicted, "指纹不匹配进入冲突态")
        XCTAssertEqual(try diskText(path), "外部版本")

        // 继续编辑后再次普通保存仍被拒绝——覆盖必须显式。
        await model.resolveWorkspaceFileConflict(path: path, action: .continueEditing)
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isConflicted)
        let second = await model.saveWorkspaceFileDraft(path: path)
        XCTAssertFalse(second)
        XCTAssertTrue(model.workspaceFileTabs[0].draft!.isConflicted)

        await model.resolveWorkspaceFileConflict(path: path, action: .overwrite)
        XCTAssertEqual(try diskText(path), "缓冲区版本", "显式覆盖写入缓冲区内容")
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isConflicted)
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isDirty)
    }

    func testConflictReloadDiscardsDraftAndRefreshesSnapshot() async throws {
        let path = try makeFile(content: "基准")
        let model = try await makeLoadedTab(path: path)
        model.startEditingWorkspaceFile(path: path)
        model.updateWorkspaceFileDraft(path: path, text: "未保存的编辑")
        try "磁盘新版".write(toFile: path, atomically: true, encoding: .utf8)

        await model.resolveWorkspaceFileConflict(path: path, action: .reloadFromDisk)
        XCTAssertNil(model.workspaceFileTabs[0].draft, "重新加载放弃缓冲区")
        XCTAssertEqual(model.workspaceFileTabs[0].snapshot?.text, "磁盘新版")
    }

    func testClosingDirtyTabRequiresConfirmationAndCanSaveFirst() async throws {
        let path = try makeFile(content: "初始")
        let model = try await makeLoadedTab(path: path)
        model.startEditingWorkspaceFile(path: path)
        model.updateWorkspaceFileDraft(path: path, text: "关闭前保存")

        model.closeWorkspaceFileTab(path: path)
        XCTAssertEqual(model.pendingWorkspaceFileClose, path, "脏标签关闭先弹确认")
        XCTAssertEqual(model.workspaceFileTabs.count, 1)

        model.cancelCloseWorkspaceFileTab()
        XCTAssertNil(model.pendingWorkspaceFileClose)
        XCTAssertEqual(model.workspaceFileTabs.count, 1, "取消保留标签")

        model.closeWorkspaceFileTab(path: path)
        await model.closeWorkspaceFileTabAfterConfirmation(save: true)
        XCTAssertTrue(model.workspaceFileTabs.isEmpty, "保存并关闭移除标签")
        XCTAssertEqual(try diskText(path), "关闭前保存")
    }

    func testClosingDirtyTabWithoutSaveDiscardsBuffer() async throws {
        let path = try makeFile(content: "初始")
        let model = try await makeLoadedTab(path: path)
        model.startEditingWorkspaceFile(path: path)
        model.updateWorkspaceFileDraft(path: path, text: "将被丢弃")

        model.closeWorkspaceFileTab(path: path)
        await model.closeWorkspaceFileTabAfterConfirmation(save: false)
        XCTAssertTrue(model.workspaceFileTabs.isEmpty)
        XCTAssertEqual(try diskText(path), "初始", "不保存关闭不写盘")
    }

    func testRevokedAuthorizationKeepsBufferButRefusesSave() async throws {
        let path = try makeFile(content: "初始")
        let model = try await makeLoadedTab(path: path)
        model.startEditingWorkspaceFile(path: path)
        model.updateWorkspaceFileDraft(path: path, text: "授权后的编辑")
        model.workspaceFileTabs[0].authorizationAvailable = false

        let saved = await model.saveWorkspaceFileDraft(path: path)
        XCTAssertFalse(saved)
        XCTAssertNotNil(model.workspaceFileTabs[0].draft, "缓冲区保留在内存")
        XCTAssertNotNil(model.workspaceFileTabs[0].draft?.failureMessage)
        XCTAssertEqual(try diskText(path), "初始", "授权移除后零写入")
    }

    func testNonMarkdownFileCannotEnterEditing() async throws {
        let path = try makeFile("script.swift", content: "print(1)")
        let model = try await makeLoadedTab(path: path)
        model.startEditingWorkspaceFile(path: path)
        XCTAssertNil(model.workspaceFileTabs[0].draft, "仅 Markdown 可编辑（ADR 0025）")
        XCTAssertFalse(WorkspaceFileEditPolicy.isEditableMarkdown(path: path))
        XCTAssertTrue(WorkspaceFileEditPolicy.isEditableMarkdown(path: path + ".md"))
        XCTAssertTrue(WorkspaceFileEditPolicy.isEditableMarkdown(path: "/x/README.MD"))
    }
}

// MARK: - 文件视图渲染冒烟

@MainActor
final class WorkspaceFileEditingRenderTests: XCTestCase {
    func testMarkdownSourceEditingRendersEditorAndConflictCard() {
        let model = AppModel()
        model.workspaceFileTabs = [WorkspaceFileTab(
            path: "/tmp/proj/notes.md",
            sourceFolderPath: "/tmp/proj",
            requestedLine: nil,
            snapshot: WorkspaceFileSnapshot(
                path: "/tmp/proj/notes.md",
                sourceFolderPath: "/tmp/proj",
                relativePath: "notes.md",
                text: "# 标题",
                byteCount: 32,
                contentDigest: String(repeating: "a", count: 64),
                loadedAt: Date()
            ),
            errorMessage: nil,
            isLoading: false,
            authorizationAvailable: true,
            draft: WorkspaceFileDraft(
                text: "# 标题\n修改",
                baseText: "# 标题",
                baseDigest: String(repeating: "a", count: 64),
                isSaving: false,
                isConflicted: true,
                failureMessage: nil
            ),
            viewMode: .source
        )]
        model.workspaceTabSelection = .file("/tmp/proj/notes.md")

        let host = NSHostingView(
            rootView: WorkspaceContentView { Text("对话") }
                .environment(model)
                .frame(width: 720, height: 480)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "冲突态 source 编辑必须完成布局")
    }

    func testMarkdownPreviewRendersBufferedDocument() {
        let model = AppModel()
        model.workspaceFileTabs = [WorkspaceFileTab(
            path: "/tmp/proj/readme.md",
            sourceFolderPath: "/tmp/proj",
            requestedLine: nil,
            snapshot: WorkspaceFileSnapshot(
                path: "/tmp/proj/readme.md",
                sourceFolderPath: "/tmp/proj",
                relativePath: "readme.md",
                text: "# 旧标题",
                byteCount: 8,
                contentDigest: String(repeating: "b", count: 64),
                loadedAt: Date()
            ),
            errorMessage: nil,
            isLoading: false,
            authorizationAvailable: true,
            draft: WorkspaceFileDraft(
                text: "# 缓冲区标题",
                baseText: "# 缓冲区标题",
                baseDigest: String(repeating: "c", count: 64)
            ),
            viewMode: .preview
        )]
        model.workspaceTabSelection = .file("/tmp/proj/readme.md")

        let host = NSHostingView(
            rootView: WorkspaceContentView { Text("对话") }
                .environment(model)
                .frame(width: 720, height: 480)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "预览态必须完成布局")
    }

    func testNonMarkdownStaysReadOnly() {
        let model = AppModel()
        model.workspaceFileTabs = [WorkspaceFileTab(
            path: "/tmp/proj/main.swift",
            sourceFolderPath: "/tmp/proj",
            requestedLine: 3,
            snapshot: WorkspaceFileSnapshot(
                path: "/tmp/proj/main.swift",
                sourceFolderPath: "/tmp/proj",
                relativePath: "main.swift",
                text: "let a = 1\nlet b = 2\nlet c = 3",
                byteCount: 30,
                contentDigest: String(repeating: "d", count: 64),
                loadedAt: Date()
            ),
            errorMessage: nil,
            isLoading: false,
            authorizationAvailable: true
        )]
        model.workspaceTabSelection = .file("/tmp/proj/main.swift")

        let host = NSHostingView(
            rootView: WorkspaceContentView { Text("对话") }
                .environment(model)
                .frame(width: 720, height: 480)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "非 Markdown 只读路径不回退")
    }
}
