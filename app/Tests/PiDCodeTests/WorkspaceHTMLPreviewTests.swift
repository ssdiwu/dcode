import SwiftUI
import XCTest
@testable import PiDCode

/// 0.0.18 HTML 隔离即时预览（ADR 0026）：资源解析 / 联网询问状态机 /
/// 原始字节安全读取 / HTML 编辑流集成与渲染冒烟。全部使用真实临时目录
/// （仓库 .build 下，避开 /var 符号链接），不触碰用户数据。
@MainActor
final class WorkspaceHTMLPreviewTests: XCTestCase {
    private var rootURL: URL!

    override func setUpWithError() throws {
        rootURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent(".build", isDirectory: true)
            .appendingPathComponent("DCodeWorkspaceHTMLPreview-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: rootURL)
    }

    private var root: String { rootURL.path }

    // MARK: - 编辑准入

    func testEditPolicyAcceptsHTMLExtensionsOnly() {
        XCTAssertTrue(WorkspaceFileEditPolicy.isEditableHTML(path: "/repo/a.html"))
        XCTAssertTrue(WorkspaceFileEditPolicy.isEditableHTML(path: "/repo/a.htm"))
        XCTAssertTrue(WorkspaceFileEditPolicy.isEditableHTML(path: "/repo/A.HTML"))
        XCTAssertFalse(WorkspaceFileEditPolicy.isEditableHTML(path: "/repo/a.md"))
        XCTAssertFalse(WorkspaceFileEditPolicy.isEditableHTML(path: "/repo/html"))
        XCTAssertFalse(WorkspaceFileEditPolicy.isEditableHTML(path: "/repo/a.html.swift"))
        XCTAssertFalse(WorkspaceFileEditPolicy.isEditableMarkdown(path: "/repo/a.html"))
    }

    // MARK: - 资源 scheme 解析

    func testAssetSchemeResolvesFilesInsideAuthorizedRootOnly() throws {
        let directory = rootURL.appending(path: "site", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let baseURL = try XCTUnwrap(WorkspaceHTMLAssetScheme.makeBaseURL(directoryPath: directory.path))
        XCTAssertEqual(baseURL.scheme, WorkspaceHTMLAssetScheme.name)

        // 根内相对资源（含子目录）解析回授权根内绝对路径。
        let css = try XCTUnwrap(URL(string: "style.css", relativeTo: baseURL)?.absoluteURL)
        XCTAssertEqual(
            WorkspaceHTMLAssetScheme.resolveFilePath(from: css, sourceFolderPath: root),
            (directory.path as NSString).appendingPathComponent("style.css")
        )
        let nested = try XCTUnwrap(URL(string: "assets/logo.png", relativeTo: baseURL)?.absoluteURL)
        XCTAssertNotNil(WorkspaceHTMLAssetScheme.resolveFilePath(from: nested, sourceFolderPath: root))

        // ../.. 越出授权根：直接失败，不给出路径。
        let escaping = try XCTUnwrap(URL(string: "../../etc/passwd", relativeTo: baseURL)?.absoluteURL)
        XCTAssertNil(WorkspaceHTMLAssetScheme.resolveFilePath(from: escaping, sourceFolderPath: root))

        // scheme / host 不符与绝对 http URL 一律失败。
        XCTAssertNil(WorkspaceHTMLAssetScheme.resolveFilePath(
            from: URL(string: "https://example.com/x.css")!,
            sourceFolderPath: root
        ))
        XCTAssertNil(WorkspaceHTMLAssetScheme.resolveFilePath(
            from: URL(string: "file:///etc/passwd")!,
            sourceFolderPath: root
        ))

        // query / fragment 不参与路径判定。
        let withQuery = try XCTUnwrap(URL(string: "style.css?v=2", relativeTo: baseURL)?.absoluteURL)
        XCTAssertNotNil(WorkspaceHTMLAssetScheme.resolveFilePath(from: withQuery, sourceFolderPath: root))
    }

    func testAssetMIMEMapping() {
        XCTAssertEqual(WorkspaceHTMLAssetMIME.mimeType(forPath: "/a/b/index.html"), "text/html")
        XCTAssertEqual(WorkspaceHTMLAssetMIME.mimeType(forPath: "/a/b/style.CSS"), "text/css")
        XCTAssertEqual(WorkspaceHTMLAssetMIME.mimeType(forPath: "/a/b/logo.png"), "image/png")
        XCTAssertEqual(WorkspaceHTMLAssetMIME.mimeType(forPath: "/a/b/app.js"), "text/javascript")
        XCTAssertEqual(WorkspaceHTMLAssetMIME.mimeType(forPath: "/a/b/unknown.xyz"), "application/octet-stream")
    }

    // MARK: - 原始字节安全读取

    func testReadRawBytesReturnsBinaryAndRefusesBoundaries() async throws {
        let directory = rootURL.appending(path: "assets", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let binary = directory.appending(path: "logo.png")
        try Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A]).write(to: binary)

        let data = try await WorkspaceFileReader.readRawBytes(
            path: binary.path,
            sourceFolderPath: root,
            maximumBytes: 8 * 1_024 * 1_024
        )
        XCTAssertEqual(data, Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A]), "二进制资源原样返回，不做文本检测")

        do {
            _ = try await WorkspaceFileReader.readRawBytes(
                path: "/etc/hosts",
                sourceFolderPath: root,
                maximumBytes: 8 * 1_024 * 1_024
            )
            XCTFail("越界必须拒绝")
        } catch let error as WorkspaceFileReaderError {
            XCTAssertEqual(error, .outsideSourceFolder)
        }

        let alias = directory.appending(path: "alias.png").path
        try FileManager.default.createSymbolicLink(
            atPath: alias,
            withDestinationPath: "logo.png"
        )
        do {
            _ = try await WorkspaceFileReader.readRawBytes(
                path: alias,
                sourceFolderPath: root,
                maximumBytes: 8 * 1_024 * 1_024
            )
            XCTFail("符号链接必须拒绝")
        } catch let error as WorkspaceFileReaderError {
            XCTAssertEqual(error, .symbolicLink)
        }
    }

    // MARK: - 联网询问状态机（ADR 0026 决定 3）

    func testNetworkPolicyAskAllowsAndResetsAcrossFiles() {
        let state = HTMLPreviewState()
        XCTAssertFalse(state.isNetworkAllowed(path: "/p/page.html"))

        state.recordNetworkAttempt(path: "/p/page.html", url: "https://cdn.example.com/x.js")
        XCTAssertEqual(state.pendingAttemptPath, "/p/page.html")
        XCTAssertEqual(state.pendingAttemptURL, "https://cdn.example.com/x.js")

        state.keepBlocked()
        XCTAssertNil(state.pendingAttemptPath)
        XCTAssertFalse(state.isNetworkAllowed(path: "/p/page.html"), "保持阻止后维持阻断")

        state.recordNetworkAttempt(path: "/p/page.html", url: "https://cdn.example.com/x.js")
        state.allowNetwork(path: "/p/page.html")
        XCTAssertTrue(state.isNetworkAllowed(path: "/p/page.html"))
        XCTAssertNil(state.pendingAttemptPath)
        // 已放行的文件再次联网尝试不再弹询问。
        state.recordNetworkAttempt(path: "/p/page.html", url: "https://cdn.example.com/y.js")
        XCTAssertNil(state.pendingAttemptPath)

        // 切到别的文件：放行不跨文件延续。
        state.handleFileSelectionChanged(selectedPath: "/p/other.html")
        XCTAssertFalse(state.isNetworkAllowed(path: "/p/page.html"))
        state.allowNetwork(path: "/p/page.html")
        state.handleFileSelectionChanged(selectedPath: nil)
        XCTAssertFalse(state.isNetworkAllowed(path: "/p/page.html"), "回到对话即恢复阻断")
    }

    // MARK: - HTML 编辑流集成（复用 0.0.17 缓冲区）

    func testHTMLOpensIntoEditingDraftAndSavesViaSharedBuffer() async throws {
        let file = rootURL.appending(path: "page.html")
        try "<p>旧内容</p>".write(to: file, atomically: true, encoding: .utf8)
        let model = AppModel()
        model.projects = [DCodeProject(
            id: UUID(),
            name: "HTML 测试项目",
            sourceFolders: [SourceFolder(path: root)]
        )]

        await model.openWorkspaceFile(path: file.path, sourceFolderPath: root)
        XCTAssertEqual(model.workspaceFileTabs.count, 1)
        XCTAssertNotNil(model.workspaceFileTabs[0].draft, "HTML 打开即建立编辑缓冲区（ADR 0026 决定 5）")
        XCTAssertEqual(model.workspaceFileTabs[0].draft?.text, "<p>旧内容</p>")

        model.updateWorkspaceFileDraft(path: file.path, text: "<p>新内容</p>")
        XCTAssertTrue(model.workspaceFileTabs[0].draft!.isDirty)
        XCTAssertTrue(model.canSaveSelectedWorkspaceFileDraft)

        let saved = await model.saveWorkspaceFileDraft(path: file.path)
        XCTAssertTrue(saved, "HTML 保存复用 Markdown 的 Writer 与冲突语义")
        XCTAssertEqual(try String(contentsOfFile: file.path, encoding: .utf8), "<p>新内容</p>")
        XCTAssertFalse(model.workspaceFileTabs[0].draft!.isDirty)
    }
}

// MARK: - 渲染冒烟

@MainActor
final class WorkspaceHTMLPreviewRenderTests: XCTestCase {
    func testHTMLSplitEditorAndNetworkPromptRender() {
        let model = AppModel()
        model.workspaceFileTabs = [WorkspaceFileTab(
            path: "/tmp/proj/page.html",
            sourceFolderPath: "/tmp/proj",
            requestedLine: nil,
            snapshot: WorkspaceFileSnapshot(
                path: "/tmp/proj/page.html",
                sourceFolderPath: "/tmp/proj",
                relativePath: "page.html",
                text: "<p>hello</p>",
                byteCount: 13,
                contentDigest: String(repeating: "e", count: 64),
                loadedAt: Date()
            ),
            errorMessage: nil,
            isLoading: false,
            authorizationAvailable: true,
            draft: WorkspaceFileDraft(
                text: "<p>hello</p>",
                baseText: "<p>hello</p>",
                baseDigest: String(repeating: "e", count: 64)
            )
        )]
        model.workspaceTabSelection = .file("/tmp/proj/page.html")
        model.htmlPreview.recordNetworkAttempt(
            path: "/tmp/proj/page.html",
            url: "https://cdn.example.com/x.js"
        )

        let host = NSHostingView(
            rootView: WorkspaceContentView { Text("对话") }
                .environment(model)
                .frame(width: 900, height: 560)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "HTML 双栏与联网询问条必须完成布局")
    }
}
