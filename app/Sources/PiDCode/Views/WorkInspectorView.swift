import AppKit
import SwiftUI

struct WorkInspectorView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            switch model.inspectorScope {
            case let .project(projectID):
                if let project = model.projects.first(where: { $0.id == projectID }) {
                    ProjectInspectorView(project: project, sessionInspection: nil)
                } else {
                    ContentUnavailableView("项目不存在", systemImage: "folder.badge.questionmark")
                }
            case .session:
                if let inspection = model.inspection,
                   let ownership = model.projectOwnership(for: inspection.summary) {
                    ProjectInspectorView(
                        project: ownership.project,
                        sessionInspection: inspection
                    )
                } else {
                    SessionOnlyInspectorView()
                }
            case nil:
                ContentUnavailableView("没有可检查的内容", systemImage: "sidebar.right")
            }
        }
        .dCodeFloatingSurface()
    }
}

private struct ProjectInspectorView: View {
    enum Tab: String, CaseIterable, Identifiable {
        case session = "会话"
        case files = "文件"
        case changes = "变更"
        var id: String { rawValue }
    }

    let project: DCodeProject
    let sessionInspection: SessionInspection?
    @State private var tab: Tab = .files

    private var availableTabs: [Tab] {
        sessionInspection == nil ? [.files, .changes] : [.session, .files, .changes]
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker(selection: $tab) {
                ForEach(availableTabs) { tab in Text(tab.rawValue).tag(tab) }
            } label: {
                EmptyView()
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("信息检查器范围")
            .padding(12)

            switch tab {
            case .files:
                ProjectFilesView(project: project)
            case .changes:
                ProjectChangesView(project: project)
            case .session:
                SessionInspectorView()
            }
        }
        .id("\(project.id.uuidString):\(sessionInspection?.summary.id ?? "project")")
    }
}

private struct SessionOnlyInspectorView: View {
    var body: some View {
        VStack(spacing: 0) {
            Picker(selection: .constant("会话")) {
                Text("会话").tag("会话")
            } label: {
                EmptyView()
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("信息检查器范围")
            .padding(12)

            SessionInspectorView()
        }
    }
}

private struct ProjectFilesView: View {
    let project: DCodeProject

    var body: some View {
        switch ProjectFileTreeLayout.resolve(for: project) {
        case .empty:
            ContentUnavailableView(
                "没有源文件夹",
                systemImage: "folder.badge.plus",
                description: Text("编辑项目并添加源文件夹后，这里会显示真实文件树。")
            )
        case let .flattened(folder):
            FlattenedFileTreeRoot(folder: folder)
                .id(folder.path)
        case let .grouped(folders):
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(folders) { folder in
                        FileTreeBranch(
                            rootPath: folder.path,
                            node: ProjectFileNode(path: folder.path, name: folder.displayName, kind: .directory),
                            depth: 0,
                            isRoot: true
                        )
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 10)
            }
            .accessibilityLabel("项目文件树")
        }
    }
}

private struct FlattenedFileTreeRoot: View {
    let folder: SourceFolder

    @State private var loading = true
    @State private var children: [ProjectFileNode] = []
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if loading {
                ProgressView("正在读取文件…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                ContentUnavailableView(
                    "无法读取文件",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if children.isEmpty {
                ContentUnavailableView("文件夹为空", systemImage: "folder")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(children) { child in
                            FileTreeBranch(
                                rootPath: folder.path,
                                node: child,
                                depth: 0,
                                isRoot: false
                            )
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 10)
                }
                .accessibilityLabel("\(folder.displayName) 文件树")
            }
        }
        .task(id: folder.path) {
            loading = true
            errorMessage = nil
            do {
                children = try await FileTreeReader.children(
                    rootPath: folder.path,
                    directoryPath: folder.path
                )
            } catch is CancellationError {
                return
            } catch {
                children = []
                errorMessage = DiagnosticSanitizer.redact(error.localizedDescription)
            }
            loading = false
        }
    }
}

private struct FileTreeBranch: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rootPath: String
    let node: ProjectFileNode
    let depth: Int
    let isRoot: Bool

    @State private var expanded = false
    @State private var loading = false
    @State private var children: [ProjectFileNode]?
    @State private var errorMessage: String?
    @State private var hovering = false
    @FocusState private var rowFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if node.isExpandable {
                Button(action: toggle) {
                    rowLabel
                }
                .buttonStyle(.plain)
                .focused($rowFocused)
                .focusEffectDisabled()
                .rowFocusRing(rowFocused)
                .onKeyPress(.rightArrow) {
                    if !expanded { expanded = true }
                    return .handled
                }
                .onKeyPress(.leftArrow) {
                    guard expanded else { return .ignored }
                    expanded = false
                    return .handled
                }
                .accessibilityLabel("\(expanded ? "收起" : "展开") \(node.name)")
            } else if node.kind == .file || node.kind == .symbolicLink {
                Button {
                    Task {
                        await model.openWorkspaceFile(
                            path: node.path,
                            sourceFolderPath: rootPath
                        )
                    }
                } label: {
                    rowLabel
                }
                .buttonStyle(.plain)
                .focused($rowFocused)
                .focusEffectDisabled()
                .rowFocusRing(rowFocused)
                .accessibilityLabel("打开只读文件 \(node.name)")
            } else {
                rowLabel
                    .accessibilityElement(children: .combine)
            }

            if expanded {
                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在读取…")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, CGFloat(depth + 1) * 16 + 30)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                } else if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .padding(.leading, CGFloat(depth + 1) * 16 + 30)
                        .padding(.vertical, 5)
                } else if children?.isEmpty == true {
                    Text("空文件夹")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, CGFloat(depth + 1) * 16 + 30)
                        .padding(.vertical, 5)
                } else {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(children ?? []) { child in
                            FileTreeBranch(rootPath: rootPath, node: child, depth: depth + 1, isRoot: false)
                        }
                    }
                }
            }
        }
        .task(id: expanded) {
            guard expanded, children == nil, errorMessage == nil else { return }
            loading = true
            do {
                children = try await FileTreeReader.children(rootPath: rootPath, directoryPath: node.path)
            } catch {
                errorMessage = DiagnosticSanitizer.redact(error.localizedDescription)
            }
            loading = false
        }
    }

    private var rowLabel: some View {
        HStack(spacing: 7) {
            if node.isExpandable {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: 12)
            } else {
                Color.clear.frame(width: 12, height: 1)
            }
            Image(systemName: icon)
                .foregroundStyle(node.kind == .symbolicLink ? .purple : .secondary)
            Text(node.name)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if node.kind == .symbolicLink {
                Text("链接")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, CGFloat(depth) * 16)
        .padding(.horizontal, 6)
        .frame(minHeight: PiDCodeMetrics.minimumTarget)
        .contentShape(Rectangle())
        .background(rowBackground, in: RoundedRectangle(cornerRadius: 7))
        .help(node.path)
        .onHover { hovering = $0 }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .contextMenu {
            Button("引用到输入框", systemImage: "text.insert") {
                model.insertComposerReference(node.path)
            }
            Button("在 Finder 中显示", systemImage: "folder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: node.path)])
            }
            Button("拷贝路径", systemImage: "doc.on.doc") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.path, forType: .string)
            }
        }
    }

    private var rowBackground: Color {
        if isRoot { return Color.primary.opacity(0.045) }
        return hovering ? Color.primary.opacity(0.05) : .clear
    }

    private var icon: String {
        switch node.kind {
        case .directory: expanded ? "folder.fill" : "folder"
        case .file: "doc"
        case .symbolicLink: "link"
        case .other: "questionmark.square.dashed"
        }
    }

    private func toggle() {
        guard node.isExpandable else { return }
        expanded.toggle()
    }
}

private struct ProjectChangesView: View {
    let project: DCodeProject
    @State private var snapshots: [GitRepositorySnapshot] = []
    @State private var loading = false
    @State private var refreshID = UUID()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("只读 Git 工作区")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    refreshID = UUID()
                } label: {
                    IconActionGlyph(systemName: "arrow.clockwise")
                }
                .buttonStyle(IconActionStyle())
                .accessibilityLabel("刷新 Git 变更")
                .disabled(loading)
            }
            .padding(.horizontal, 12)

            if loading, snapshots.isEmpty {
                ProgressView("正在读取 Git 状态…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(snapshots) { snapshot in
                            GitRepositoryCard(snapshot: snapshot)
                        }
                    }
                    .padding(12)
                }
            }
        }
        .task(id: refreshID) {
            loading = true
            let result = await GitChangesReader.read(sourceFolders: project.sourceFolders)
            guard !Task.isCancelled else { return }
            snapshots = result
            loading = false
        }
    }
}

private struct GitRepositoryCard: View {
    let snapshot: GitRepositorySnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(URL(fileURLWithPath: snapshot.rootPath).lastPathComponent)
                        .font(.callout.weight(.semibold))
                    Text(snapshot.rootPath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            }

            switch snapshot.state {
            case let .ready(branch, changes):
                Label(branch, systemImage: "arrow.triangle.branch")
                    .font(.caption)
                if changes.isEmpty {
                    Label("工作区干净", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else {
                    LazyVStack(alignment: .leading, spacing: 9) {
                        ForEach(changes) { change in
                            GitChangeDiffRow(rootPath: snapshot.rootPath, change: change)
                        }
                    }
                    Text("真实 Git 差异 · 只读 · 不提供 stage / discard / commit")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            case .notRepository:
                Label("不是 Git 仓库", systemImage: "minus.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case let .failed(message):
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                .strokeBorder(Color.primary.opacity(0.09))
        }
    }

    private func statusColor(_ status: String) -> Color {
        if status == "??" { return .blue }
        if status.contains("D") { return .red }
        if status.contains("A") { return .green }
        return .orange
    }
}

private struct SessionInspectorView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let inspection = model.inspection {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    inspectorSection("会话概览") {
                        LabeledContent("消息", value: "\(inspection.summary.messageCount)")
                        LabeledContent("会话 ID") {
                            Text(inspection.summary.id)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)
                                .allowsTightening(true)
                                .layoutPriority(1)
                                .textSelection(.enabled)
                                .help(inspection.summary.id)
                        }
                    }
                    inspectorSection("工作目录") {
                        Text(inspection.summary.cwd)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                    if let plan = model.activePlan {
                        inspectorSection("活动计划") {
                            Text(plan.objective)
                                .font(.callout)
                            ProgressView(value: plan.progress)
                            Text("已完成 \(plan.completedCount) / \(plan.totalCount)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    inspectorSection("运行证据") {
                        VerificationEvidenceSection()
                    }
                }
                .padding(14)
            }
        } else {
            ContentUnavailableView("尚未打开会话", systemImage: "bubble.left")
        }
    }

    private func inspectorSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.headline)
            content()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
    }
}

/// 单个 Git 变更文件：展开后按需读取 staged / unstaged 精确差异。
private struct GitChangeDiffRow: View {
    @Environment(AppModel.self) private var model
    let rootPath: String
    let change: GitChange
    @State private var expanded = false
    @State private var result: GitFileDiffResult?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                expanded.toggle()
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                    Text(change.status)
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(statusColor(change.status))
                        .frame(width: 22, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(change.path)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        if let originalPath = change.originalPath {
                            Text("来自 \(originalPath)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        if let summary = countSummary {
                            Text(summary)
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("引用到输入框", systemImage: "text.insert") {
                    model.insertComposerReference(diffReference)
                }
            }

            if expanded {
                diffBody
                    .task {
                        guard result == nil, !loading else { return }
                        loading = true
                        result = await loadDiff()
                        loading = false
                    }
            }
        }
    }

    /// 界面即上下文：文件级引用带当前已知的暂存 / 未暂存增删摘要。
    private var diffReference: String {
        guard let result else { return absoluteChangePath }
        var parts: [String] = []
        if let staged = result.staged, staged.additions + staged.deletions > 0 {
            parts.append("已暂存 \(signature(staged))")
        }
        if let unstaged = result.unstaged, unstaged.additions + unstaged.deletions > 0 {
            parts.append("未暂存 \(signature(unstaged))")
        }
        return parts.isEmpty ? absoluteChangePath : "\(absoluteChangePath)（\(parts.joined(separator: "、"))）"
    }

    private var absoluteChangePath: String {
        change.path.hasPrefix("/")
            ? change.path
            : "\(rootPath)/\(change.path)"
    }

    private var countSummary: String? {
        guard let result else { return nil }
        var parts: [String] = []
        if let staged = result.staged, staged.additions + staged.deletions > 0 || staged.isBinary {
            parts.append("已暂存 \(signature(staged))")
        }
        if let unstaged = result.unstaged, unstaged.additions + unstaged.deletions > 0 || unstaged.isBinary {
            parts.append("未暂存 \(signature(unstaged))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func signature(_ diff: GitFileDiff) -> String {
        diff.isBinary ? "二进制" : "+\(diff.additions) −\(diff.deletions)"
    }

    private var diffBody: some View {
        LazyVStack(alignment: .leading, spacing: 6) {
            if loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("正在读取差异…").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let failure = result?.failure {
                Text("读取失败：\(failure)")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let staged = result?.staged {
                GitDiffSection(
                    title: "已暂存",
                    diff: staged,
                    filePath: absoluteChangePath
                )
            }
            if let unstaged = result?.unstaged {
                GitDiffSection(
                    title: "未暂存",
                    diff: unstaged,
                    filePath: absoluteChangePath
                )
            }
            if change.status == "??" {
                Text("未跟踪文件 · 完整内容即为新增")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let result, !result.isEmpty, result.staged == nil, result.unstaged == nil {
                Text("暂无可显示的差异。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 30)
    }

    private func loadDiff() async -> GitFileDiffResult {
        if change.status == "??" {
            // 未跟踪文件：diff 无输出；把整份内容当作“新文件”预览
            let absolute = change.path.hasPrefix("/")
                ? change.path
                : rootPath + "/" + change.path
            let snapshot: WorkspaceFileSnapshot
            do {
                snapshot = try await WorkspaceFileReader.read(path: absolute, sourceFolderPath: rootPath)
            } catch {
                return GitFileDiffResult(staged: nil, unstaged: nil, failure: error.localizedDescription)
            }
            do {
                let lines = snapshot.text.split(separator: "\n", omittingEmptySubsequences: false)
                let diffLines = lines.enumerated().map { index, line in
                    GitDiffLine(kind: .added, oldLineNumber: nil, newLineNumber: index + 1, text: String(line))
                }
                let hunks = lines.isEmpty ? [] : [GitDiffHunk(
                    oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.count,
                    sectionHeading: "新文件", lines: Array(diffLines.prefix(UnifiedDiffParser.maxDiffLines))
                )]
                return GitFileDiffResult(
                    staged: nil,
                    unstaged: GitFileDiff(
                        path: change.path,
                        hunks: hunks,
                        isBinary: false,
                        isTruncated: lines.count > UnifiedDiffParser.maxDiffLines,
                        totalHunks: hunks.count
                    ),
                    failure: nil
                )
            }
        }
        return await GitDiffReader.fileDiff(repoRoot: rootPath, path: change.path)
    }

    private func statusColor(_ status: String) -> Color {
        if status == "??" { return .blue }
        if status.hasPrefix("A") || status.hasPrefix("M") { return .orange }
        if status.hasPrefix("D") { return .red }
        if status.hasPrefix("R") || status.hasPrefix("C") { return .purple }
        return .secondary
    }
}

/// staged / unstaged 一段差异：hunk 头 + 逐行着色。
struct GitDiffSection: View {
    let title: String
    let diff: GitFileDiff
    /// 界面即上下文：hunk 引用需要的绝对路径；缺省时 hunk 不提供引用动作。
    var filePath: String = ""

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                if diff.isBinary {
                    Text("二进制文件").font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text("+\(diff.additions)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                    Text("−\(diff.deletions)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
                }
                if diff.isTruncated {
                    Text("差异过大，仅显示前 \(diff.hunks.count)/\(diff.totalHunks) 个 hunk")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            if !diff.isBinary {
                ForEach(diff.hunks) { hunk in
                    GitDiffHunkView(filePath: filePath, zone: title, hunk: hunk)
                }
            }
        }
    }
}

struct GitDiffHunkView: View {
    @Environment(AppModel.self) private var model
    let filePath: String
    let zone: String
    let hunk: GitDiffHunk

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("@@ -\(hunk.oldStart),\(hunk.oldCount) +\(hunk.newStart),\(hunk.newCount) @@ \(hunk.sectionHeading)")
                .font(.caption2.monospaced().weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.vertical, 2)
                .contextMenu {
                    if !filePath.isEmpty {
                        Button("引用到输入框", systemImage: "text.insert") {
                            let lastLine = hunk.newStart + max(0, hunk.newCount - 1)
                            model.insertComposerReference("\(filePath) 第 \(hunk.newStart)–\(lastLine) 行（\(zone)）")
                        }
                    }
                }
            ForEach(hunk.lines) { line in
                GitDiffLineView(line: line)
            }
        }
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 4))
    }
}

private struct GitDiffLineView: View {
    let line: GitDiffLine

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(line.oldLineNumber.map(String.init) ?? "")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 34, alignment: .trailing)
            Text(line.newLineNumber.map(String.init) ?? "")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 34, alignment: .trailing)
            Text(prefix + line.text)
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 0.5)
        .padding(.horizontal, 4)
        .background(background.opacity(0.08))
    }

    private var prefix: String {
        switch line.kind {
        case .added: "+"
        case .removed: "-"
        case .context: " "
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: .green
        case .removed: .red
        case .context: .clear
        }
    }
}

/// 会话级运行证据：真实 bash 执行的命令、退出推导、耗时与 revision。
/// 证据来自 Host 转发的工具执行事实；Agent 文案宣称不构成证据。
struct VerificationEvidenceSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.verificationEvidence.isEmpty {
            Text("本会话还没有可复核的命令执行记录。")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(model.verificationEvidence.prefix(20)) { record in
                    VerificationEvidenceRow(record: record)
                }
                Text("证据来自真实工具运行 · Agent 文案不构成证据 · 不是发布门禁")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

struct VerificationEvidenceRow: View {
    @Environment(AppModel.self) private var model
    let record: VerificationEvidenceRecord
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                expanded.toggle()
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Image(systemName: symbol)
                        .foregroundStyle(symbolColor)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(record.command)
                            .font(.caption.monospaced())
                            .lineLimit(expanded ? nil : 1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        HStack(spacing: 8) {
                            Text(exitLabel)
                                .font(.caption2.weight(.semibold))
                            Text(ConversationTimingFormatter.durationText(Double(record.durationMs) / 1_000) ?? "")
                                .font(.caption2.monospacedDigit())
                            if let revision = record.gitRevision {
                                Text(String(revision.prefix(7)))
                                    .font(.caption2.monospaced())
                                } else {
                                Text("revision 待补")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("引用到输入框", systemImage: "text.insert") {
                    model.insertComposerReference(
                        "验证证据：\(record.command)（\(exitLabel)，revision \(record.gitRevision ?? "待补")）"
                    )
                }
            }

            if expanded {
                VStack(alignment: .leading, spacing: 2) {
                    LabeledContent("Run") {
                        Text(record.runId)
                            .font(.caption2.monospaced())
                            .textSelection(.enabled)
                    }
                    LabeledContent("开始") {
                        Text(record.startedAt.formatted(date: .abbreviated, time: .standard))
                    }
                    LabeledContent("工作目录") {
                        Text(record.cwd)
                            .font(.caption2.monospaced())
                    }
                    if let provider = record.modelProvider, let modelId = record.modelId {
                        LabeledContent("模型") {
                            Text("\(provider)/\(modelId)")
                                .font(.caption2.monospaced())
                        }
                    }
                    if let revision = record.gitRevision {
                        LabeledContent("Revision") {
                            Text(revision)
                                .font(.caption2.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                }
                .font(.caption2)
                .padding(.leading, 18)
            }
        }
        .padding(.vertical, 1)
    }

    private var symbol: String {
        switch record.exitKind {
        case "ok": "checkmark.circle.fill"
        case "failure": "xmark.circle.fill"
        default: "questionmark.circle"
        }
    }

    private var symbolColor: Color {
        switch record.exitKind {
        case "ok": .green
        case "failure": .red
        default: .secondary
        }
    }

    private var exitLabel: String {
        switch record.exitKind {
        case "ok": "退出 0"
        case "failure": record.exitCode.map { "退出 \($0)" } ?? "失败"
        default: "退出未知"
        }
    }
}

/// 文件树行的键盘焦点环（设计系统 §5：Keyboard focus 使用独立 accent outline）。
private extension View {
    func rowFocusRing(_ focused: Bool) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(focused ? Color.accentColor.opacity(0.7) : .clear, lineWidth: 1.5)
        )
    }
}
