import SwiftUI

struct WorkspaceContentView<ConversationContent: View>: View {
    @Environment(AppModel.self) private var model
    private let conversationContent: ConversationContent

    init(@ViewBuilder conversationContent: () -> ConversationContent) {
        self.conversationContent = conversationContent()
    }

    var body: some View {
        VStack(spacing: 0) {
            if WorkspaceTabNavigation.showsFileTabStrip(fileCount: model.workspaceFileTabs.count) {
                WorkspaceFileTabBar()
            }
            ZStack {
                let conversationSelected = model.workspaceTabSelection == .conversation
                conversationContent
                    .opacity(conversationSelected ? 1 : 0)
                    .allowsHitTesting(conversationSelected)
                    .accessibilityElement(children: conversationSelected ? .contain : .ignore)
                    .accessibilityLabel("对话内容")
                    .accessibilityHidden(!conversationSelected)

                ForEach(model.workspaceFileTabs) { tab in
                    let fileSelected = model.workspaceTabSelection == .file(tab.path)
                    WorkspaceFilePreviewView(tab: tab)
                        .opacity(fileSelected ? 1 : 0)
                        .allowsHitTesting(fileSelected)
                        .accessibilityElement(children: fileSelected ? .contain : .ignore)
                        .accessibilityLabel("\(tab.relativeDisplayPath) 只读文件预览")
                        .accessibilityHidden(!fileSelected)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct WorkspaceFileTabBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(model.workspaceFileTabs) { tab in
                    HStack(spacing: 0) {
                        Button {
                            model.selectWorkspaceFileTab(path: tab.path)
                        } label: {
                            Label(tabTitle(tab), systemImage: "doc.text")
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .padding(.leading, 10)
                                .padding(.trailing, 4)
                                .frame(maxWidth: 240, minHeight: PiDCodeMetrics.compactControlHeight)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(
                            model.workspaceTabSelection == .file(tab.path) ? .isSelected : []
                        )
                        .accessibilityLabel("文件标签 \(tab.relativeDisplayPath)")

                        Button {
                            model.closeWorkspaceFileTab(path: tab.path)
                        } label: {
                            IconActionGlyph(systemName: "xmark")
                        }
                        .buttonStyle(IconActionStyle())
                        .accessibilityLabel("关闭 \(tab.relativeDisplayPath)")
                    }
                    .padding(.leading, 2)
                    .padding(.trailing, 2)
                    .background(
                        model.workspaceTabSelection == .file(tab.path)
                            ? Color.primary.opacity(0.09)
                            : Color.clear
                    )
                    .help(tab.path)
                }
            }
            .padding(.horizontal, PiDCodeMetrics.spacingGroup)
            .padding(.vertical, 4)
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("文件标签栏")
    }

    private func tabTitle(_ tab: WorkspaceFileTab) -> String {
        let duplicateName = model.workspaceFileTabs.filter { $0.title == tab.title }.count > 1
        return duplicateName ? "\(tab.title) — \(tab.relativeDisplayPath)" : tab.title
    }
}

private struct WorkspaceFilePreviewView: View {
    @Environment(AppModel.self) private var model
    let tab: WorkspaceFileTab

    var body: some View {
        VStack(spacing: 0) {
            fileHeader
            if tab.isLoading {
                ProgressView("正在安全读取文件…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let snapshot = tab.snapshot {
                if !tab.authorizationAvailable {
                    Label(
                        "来源授权已移除；以下内容是已读取的内存快照，不会再从磁盘刷新。",
                        systemImage: "lock.slash"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, PiDCodeMetrics.spacingSection)
                    .padding(.vertical, PiDCodeMetrics.spacingStandard)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08))
                }
                WorkspaceFileLinesView(snapshot: snapshot, requestedLine: tab.requestedLine)
            } else {
                fileError
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DCodeWorkbenchSurfacePolicy.centralCanvas.color)
    }

    private var fileHeader: some View {
        HStack(spacing: PiDCodeMetrics.spacingStandard) {
            VStack(alignment: .leading, spacing: 2) {
                Text(tab.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(tab.relativeDisplayPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(tab.path)
            }
            Spacer(minLength: PiDCodeMetrics.spacingSection)
            if let snapshot = tab.snapshot {
                Text(ByteCountFormatter.string(fromByteCount: Int64(snapshot.byteCount), countStyle: .file))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if tab.authorizationAvailable, !tab.isLoading {
                Button {
                    Task { await model.retryWorkspaceFile(path: tab.path) }
                } label: {
                    IconActionGlyph(systemName: "arrow.clockwise")
                }
                .buttonStyle(IconActionStyle())
                .accessibilityLabel("重新读取 \(tab.title)")
            }
        }
        .padding(.horizontal, PiDCodeMetrics.spacingSection)
        .frame(minHeight: 48)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.primary.opacity(0.07))
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    private var fileError: some View {
        VStack(spacing: PiDCodeMetrics.spacingSection) {
            ContentUnavailableView(
                "无法预览文件",
                systemImage: tab.authorizationAvailable ? "doc.badge.ellipsis" : "lock.slash",
                description: Text(tab.errorMessage ?? "文件没有可显示的文本内容。")
            )
            HStack(spacing: PiDCodeMetrics.spacingStandard) {
                if tab.authorizationAvailable {
                    Button("重试") {
                        Task { await model.retryWorkspaceFile(path: tab.path) }
                    }
                }
                Button("关闭标签") {
                    model.closeWorkspaceFileTab(path: tab.path)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct WorkspaceFileLinesView: View {
    let snapshot: WorkspaceFileSnapshot
    let requestedLine: Int?
    /// 构造时切分一次并缓存：旧实现的计算属性在每次访问（滚动、高亮、
    /// 行渲染）都对全文重新 split，大文件上是 O(n²)。
    private let lines: [Substring]

    init(snapshot: WorkspaceFileSnapshot, requestedLine: Int?) {
        self.snapshot = snapshot
        self.requestedLine = requestedLine
        self.lines = snapshot.text.split(separator: "\n", omittingEmptySubsequences: false)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines.indices, id: \.self) { index in
                        let lineNumber = index + 1
                        HStack(alignment: .firstTextBaseline, spacing: 14) {
                            Text(String(lineNumber))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(width: 48, alignment: .trailing)
                                .textSelection(.disabled)
                            Text(lines[index].isEmpty ? " " : String(lines[index]))
                                .font(.system(.callout, design: .monospaced))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .padding(.horizontal, PiDCodeMetrics.spacingGroup)
                        .padding(.vertical, 2)
                        .frame(minWidth: 1, alignment: .leading)
                        .background(
                            requestedLine == lineNumber
                                ? Color.accentColor.opacity(0.11)
                                : Color.clear
                        )
                        .id(lineNumber)
                    }
                }
                .padding(.vertical, PiDCodeMetrics.spacingStandard)
            }
            .onAppear { scrollToRequestedLine(using: proxy) }
            .onChange(of: requestedLine) { _, _ in scrollToRequestedLine(using: proxy) }
        }
        .accessibilityLabel("\(snapshot.relativePath) 只读内容")
    }

    private func scrollToRequestedLine(using proxy: ScrollViewProxy) {
        guard let requestedLine, !lines.isEmpty else { return }
        let target = min(max(requestedLine, 1), lines.count)
        Task { @MainActor in
            await Task.yield()
            proxy.scrollTo(target, anchor: .center)
        }
    }
}

private extension WorkspaceFileTab {
    var relativeDisplayPath: String {
        snapshot?.relativePath
            ?? WorkspaceFileReader.relativeComponents(of: path, inside: sourceFolderPath)?
                .joined(separator: "/")
            ?? path
    }
}
