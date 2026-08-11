import SwiftUI

struct WorkInspectorView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            inspectorHeader
            Divider()
            switch model.inspectorScope {
            case let .project(projectID):
                if let project = model.projects.first(where: { $0.id == projectID }) {
                    ProjectInspectorView(project: project)
                } else {
                    ContentUnavailableView("项目不存在", systemImage: "folder.badge.questionmark")
                }
            case .session:
                SessionInspectorView()
            case nil:
                ContentUnavailableView("没有可检查的内容", systemImage: "sidebar.right")
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var inspectorHeader: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(headerTitle)
                .font(.headline)
                .lineLimit(1)
            Text(headerSubtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
        .padding(.horizontal, 14)
    }

    private var headerTitle: String {
        switch model.inspectorScope {
        case let .project(id): model.projects.first(where: { $0.id == id })?.name ?? "项目"
        case .session: model.inspection?.summary.displayTitle ?? "会话"
        case nil: "工作检查器"
        }
    }

    private var headerSubtitle: String {
        switch model.inspectorScope {
        case .project: "当前项目"
        case .session: "当前会话"
        case nil: ""
        }
    }
}

private struct ProjectInspectorView: View {
    enum Tab: String, CaseIterable, Identifiable {
        case files = "文件"
        case changes = "变更"
        var id: String { rawValue }
    }

    let project: DCodeProject
    @State private var tab: Tab = .files

    var body: some View {
        VStack(spacing: 0) {
            Picker("项目检查范围", selection: $tab) {
                ForEach(Tab.allCases) { tab in Text(tab.rawValue).tag(tab) }
            }
            .pickerStyle(.segmented)
            .padding(12)

            Divider()

            switch tab {
            case .files:
                ProjectFilesView(project: project)
            case .changes:
                ProjectChangesView(project: project)
            }
        }
        .id(project.id)
    }
}

private struct ProjectFilesView: View {
    let project: DCodeProject

    var body: some View {
        if project.sourceFolders.isEmpty {
            ContentUnavailableView(
                "没有源文件夹",
                systemImage: "folder.badge.plus",
                description: Text("编辑项目并添加源文件夹后，这里会显示真实文件树。")
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(project.sourceFolders) { folder in
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

private struct FileTreeBranch: View {
    let rootPath: String
    let node: ProjectFileNode
    let depth: Int
    let isRoot: Bool

    @State private var expanded = false
    @State private var loading = false
    @State private var children: [ProjectFileNode]?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if node.isExpandable {
                Button(action: toggle) {
                    rowLabel
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(expanded ? "收起" : "展开") \(node.name)")
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
                    ForEach(children ?? []) { child in
                        FileTreeBranch(rootPath: rootPath, node: child, depth: depth + 1, isRoot: false)
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
        .background(isRoot ? Color.primary.opacity(0.045) : .clear, in: RoundedRectangle(cornerRadius: 7))
        .help(node.path)
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
                    Image(systemName: "arrow.clockwise")
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("刷新 Git 变更")
                .disabled(loading)
            }
            .padding(.horizontal, 12)
            Divider()

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
                    ForEach(changes) { change in
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text(change.status)
                                .font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(statusColor(change.status))
                                .frame(width: 24, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(change.path)
                                    .font(.caption.monospaced())
                                    .textSelection(.enabled)
                                if let originalPath = change.originalPath {
                                    Text("来自 \(originalPath)")
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
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
                                .textSelection(.enabled)
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
