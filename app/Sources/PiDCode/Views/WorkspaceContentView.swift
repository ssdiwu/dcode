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
                        .accessibilityLabel("\(tab.relativeDisplayPath) 文件视图")
                        .accessibilityHidden(!fileSelected)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(saveShortcutAnchor)
        .onAppear { syncHTMLPreviewSelection() }
        .onChange(of: model.workspaceTabSelection) { syncHTMLPreviewSelection() }
        .confirmationDialog(
            "有未保存的修改",
            isPresented: Binding(
                get: { model.pendingWorkspaceFileClose != nil },
                set: { if !$0 { model.cancelCloseWorkspaceFileTab() } }
            ),
            titleVisibility: .visible
        ) {
            Button("保存并关闭") {
                Task { await model.closeWorkspaceFileTabAfterConfirmation(save: true) }
            }
            Button("不保存关闭", role: .destructive) {
                Task { await model.closeWorkspaceFileTabAfterConfirmation(save: false) }
            }
            Button("取消", role: .cancel) { model.cancelCloseWorkspaceFileTab() }
        } message: {
            if let path = model.pendingWorkspaceFileClose,
               let tab = model.workspaceFileTabs.first(where: { $0.path == path }) {
                Text("“\(tab.title)”的编辑缓冲区尚未保存。不保存关闭将丢弃这些修改。")
            }
        }
        .confirmationDialog(
            "放弃未保存的修改",
            isPresented: Binding(
                get: { model.pendingWorkspaceFileDiscard != nil },
                set: { if !$0 { model.cancelWorkspaceFileDiscard() } }
            ),
            titleVisibility: .visible
        ) {
            Button("放弃修改", role: .destructive) { model.discardAllPendingWorkspaceFileDraft() }
            Button("取消", role: .cancel) { model.cancelWorkspaceFileDiscard() }
        } message: {
            if let path = model.pendingWorkspaceFileDiscard,
               let tab = model.workspaceFileTabs.first(where: { $0.path == path }) {
                Text("放弃“\(tab.title)”缓冲区中未保存的修改，回到只读呈现。")
            }
        }
    }

    /// ⌘S 只作用于当前选中的文件标签，避免多个标签各挂一份快捷键造成歧义。
    @ViewBuilder
    private var saveShortcutAnchor: some View {
        if let path = model.selectedWorkspaceFilePath,
           model.workspaceFileTabs.first(where: { $0.path == path })?.draft?.isSaving != true {
            Button("保存文件") {
                Task { await model.saveWorkspaceFileDraft(path: path) }
            }
            .keyboardShortcut("s", modifiers: .command)
            .opacity(0)
            .frame(width: 0, height: 0)
            .disabled(!model.canSaveSelectedWorkspaceFileDraft)
            .accessibilityHidden(true)
        }
    }

    /// 切换文件 / 回到对话：联网放行与询问不跨文件延续（ADR 0026 决定 3）。
    private func syncHTMLPreviewSelection() {
        model.htmlPreview.handleFileSelectionChanged(selectedPath: model.selectedWorkspaceFilePath)
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
                            HStack(spacing: 5) {
                                if tab.draft?.isDirty == true {
                                    Circle()
                                        .fill(Color.accentColor)
                                        .frame(width: 6, height: 6)
                                        .accessibilityLabel("有未保存修改")
                                }
                                Label(tabTitle(tab), systemImage: "doc.text")
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
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

    private var isMarkdown: Bool {
        WorkspaceFileEditPolicy.isEditableMarkdown(path: tab.path)
    }

    private var isHTML: Bool {
        WorkspaceFileEditPolicy.isEditableHTML(path: tab.path)
    }

    var body: some View {
        VStack(spacing: 0) {
            fileHeader
            if tab.isLoading {
                ProgressView("正在安全读取文件…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let snapshot = tab.snapshot {
                if !tab.authorizationAvailable {
                    Label(
                        "来源授权已移除；以下内容是已读取的内存快照，不会再从磁盘刷新，也无法保存。",
                        systemImage: "lock.slash"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, PiDCodeMetrics.spacingSection)
                    .padding(.vertical, PiDCodeMetrics.spacingStandard)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08))
                }
                if let draft = tab.draft {
                    draftNotices(draft)
                    if isHTML {
                        // HTML 打开即“编辑缓冲区 | 即时预览”双栏（ADR 0026 决定 5）。
                        WorkspaceHTMLSplitView(
                            path: tab.path,
                            sourceFolderPath: tab.sourceFolderPath,
                            draft: draft
                        )
                    } else if isMarkdown, tab.viewMode == .preview {
                        markdownPreview(source: draft.text, draft: draft)
                    } else {
                        WorkspaceFileEditorView(path: tab.path, draft: draft)
                    }
                } else if isMarkdown, tab.viewMode == .preview {
                    markdownPreview(source: snapshot.text, draft: nil)
                } else {
                    WorkspaceFileLinesView(snapshot: snapshot, requestedLine: tab.requestedLine)
                }
            } else {
                fileError
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DCodeWorkbenchSurfacePolicy.centralCanvas.color)
    }

    @ViewBuilder
    private func draftNotices(_ draft: WorkspaceFileDraft) -> some View {
        if draft.isConflicted {
            HStack(spacing: PiDCodeMetrics.spacingStandard) {
                Label("磁盘上的文件在编辑期间被外部修改，本次保存已取消。", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("重新加载磁盘版") {
                    Task { await model.resolveWorkspaceFileConflict(path: tab.path, action: .reloadFromDisk) }
                }
                Button("覆盖保存") {
                    Task { await model.resolveWorkspaceFileConflict(path: tab.path, action: .overwrite) }
                }
                Button("继续编辑") {
                    Task { await model.resolveWorkspaceFileConflict(path: tab.path, action: .continueEditing) }
                }
            }
            .font(.callout)
            .padding(.horizontal, PiDCodeMetrics.spacingSection)
            .padding(.vertical, PiDCodeMetrics.spacingStandard)
            .background(Color.orange.opacity(0.1))
        } else if let failure = draft.failureMessage {
            Label(failure, systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(.orange)
                .padding(.horizontal, PiDCodeMetrics.spacingSection)
                .padding(.vertical, PiDCodeMetrics.spacingStandard)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.08))
        }
    }

    @ViewBuilder
    private func markdownPreview(source: String, draft: WorkspaceFileDraft?) -> some View {
        VStack(spacing: 0) {
            if draft?.isDirty == true {
                Text("预览显示的是缓冲区内容，尚未写盘。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, PiDCodeMetrics.spacingSection)
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ScrollView {
                WorkspaceMarkdownPreviewView(source: source)
                    .padding(PiDCodeMetrics.spacingSection)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var fileHeader: some View {
        HStack(spacing: PiDCodeMetrics.spacingStandard) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(tab.title)
                        .font(.headline)
                        .lineLimit(1)
                    if tab.draft?.isDirty == true {
                        Text("未保存")
                            .font(.caption2)
                            .foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                }
                Text(tab.relativeDisplayPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(tab.path)
            }
            Spacer(minLength: PiDCodeMetrics.spacingSection)
            if let draft = tab.draft {
                draftStatus(draft)
                Button {
                    Task { await model.saveWorkspaceFileDraft(path: tab.path) }
                } label: {
                    if draft.isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("保存")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!draft.isDirty || draft.isSaving || !tab.authorizationAvailable)
                .help(saveShortcutHelp)
                Button {
                    requestDiscardDraft()
                } label: {
                    Text("停止编辑")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(draft.isSaving)
            } else if isMarkdown || isHTML, tab.authorizationAvailable {
                Button("编辑") {
                    model.startEditingWorkspaceFile(path: tab.path)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(tab.snapshot == nil)
            }
            if let snapshot = tab.snapshot, tab.draft == nil {
                Text(ByteCountFormatter.string(fromByteCount: Int64(snapshot.byteCount), countStyle: .file))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if isMarkdown, tab.snapshot != nil {
                Picker("视图模式", selection: Binding(
                    get: { tab.viewMode },
                    set: { model.setWorkspaceFileViewMode(path: tab.path, mode: $0) }
                )) {
                    Text("预览").tag(WorkspaceFileViewMode.preview)
                    Text("源码").tag(WorkspaceFileViewMode.source)
                }
                .pickerStyle(.segmented)
                .controlSize(.small)
                .frame(width: 130)
                .disabled(tab.draft?.isSaving == true)
            }
            if tab.authorizationAvailable, !tab.isLoading, tab.draft == nil {
                Button {
                    Task { await model.retryWorkspaceFile(path: tab.path) }
                } label: {
                    IconActionGlyph(systemName: "arrow.clockwise")
                }
                .buttonStyle(IconActionStyle())
                .accessibilityLabel("重新读取 \(tab.title)")
                .help("重新读取磁盘内容")
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

    @ViewBuilder
    private func draftStatus(_ draft: WorkspaceFileDraft) -> some View {
        if draft.isSaving {
            Text("保存中…")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if draft.isDirty {
            Text("未保存")
                .font(.caption)
                .foregroundStyle(Color.accentColor)
        } else {
            Text("已保存")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var saveShortcutHelp: String {
        tab.authorizationAvailable ? "保存缓冲区（⌘S）" : "来源授权已移除，无法保存"
    }

    private func requestDiscardDraft() {
        if tab.draft?.isDirty == true {
            model.pendingWorkspaceFileDiscard = tab.path
        } else {
            model.discardWorkspaceFileDraft(path: tab.path)
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

/// 预览跟随缓冲区（ADR 0025 决定 6）：渲染的是传入文本而不是磁盘事实；
/// `task(id:)` 在连续输入时自动取消旧解析，形成轻量防抖。
private struct WorkspaceMarkdownPreviewView: View {
    let source: String
    @State private var document: MarkdownDocument?

    var body: some View {
        Group {
            if let document {
                MarkdownDocumentView(document: document)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, PiDCodeMetrics.spacingSection)
            }
        }
        .task(id: source) {
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            document = MarkdownDocument.parse(source)
        }
    }
}

/// HTML 双栏（ADR 0026 决定 5）：左“编辑缓冲区”右“即时预览”，窄窗口上下堆叠；
/// 不做源码 / 预览切换，预览跟随缓冲区并按联网策略隔离。
private struct WorkspaceHTMLSplitView: View {
    @Environment(AppModel.self) private var model
    let path: String
    let sourceFolderPath: String
    let draft: WorkspaceFileDraft

    private var directoryPath: String {
        (path as NSString).deletingLastPathComponent
    }

    var body: some View {
        GeometryReader { proxy in
            if proxy.size.width >= 720 {
                HStack(spacing: 0) {
                    editorPane
                    Rectangle()
                        .fill(Color.primary.opacity(0.08))
                        .frame(width: 1)
                        .accessibilityHidden(true)
                    previewPane
                }
            } else {
                VStack(spacing: 0) {
                    editorPane
                    Rectangle()
                        .fill(Color.primary.opacity(0.08))
                        .frame(height: 1)
                        .accessibilityHidden(true)
                    previewPane
                }
            }
        }
    }

    private var editorPane: some View {
        VStack(spacing: 0) {
            HStack(spacing: PiDCodeMetrics.spacingStandard) {
                Label("编辑缓冲区", systemImage: "square.and.pencil")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: PiDCodeMetrics.spacingGroup)
                Text(draft.isDirty ? "未保存" : "与磁盘一致")
                    .font(.caption)
                    .foregroundStyle(draft.isDirty ? Color.accentColor : Color.secondary)
            }
            .padding(.horizontal, PiDCodeMetrics.spacingSection)
            .frame(minHeight: 32)
            WorkspaceFileEditorView(path: path, draft: draft)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var previewPane: some View {
        WorkspaceHTMLPreviewView(
            path: path,
            draftText: draft.text,
            sourceFolderPath: sourceFolderPath,
            directoryPath: directoryPath,
            isDirty: draft.isDirty
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct WorkspaceFileEditorView: View {
    @Environment(AppModel.self) private var model
    let path: String
    let draft: WorkspaceFileDraft
    @FocusState private var focused: Bool

    var body: some View {
        TextEditor(text: Binding(
            get: { draft.text },
            set: { model.updateWorkspaceFileDraft(path: path, text: $0) }
        ))
        .font(.system(.callout, design: .monospaced))
        .scrollContentBackground(.hidden)
        .background(DCodeWorkbenchSurfacePolicy.centralCanvas.color)
        .padding(.horizontal, PiDCodeMetrics.spacingGroup)
        .padding(.vertical, PiDCodeMetrics.spacingStandard)
        .disabled(draft.isSaving)
        .focused($focused)
        .onAppear { focused = true }
        .accessibilityLabel("编辑缓冲区")
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
