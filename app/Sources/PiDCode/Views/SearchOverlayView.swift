import SwiftUI

struct SearchOverlayView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var searchFocused: Bool
    @Namespace private var searchFocusScope

    var body: some View {
        VStack(spacing: 0) {
            searchField
            Divider()
            filters
            Divider()
            resultContent
            Divider()
            footer
        }
        .frame(maxWidth: 620)
        .frame(maxHeight: 620)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12))
        }
        .shadow(color: .black.opacity(0.24), radius: 28, y: 12)
        .focusScope(searchFocusScope)
        .onAppear {
            DispatchQueue.main.async {
                searchFocused = true
            }
        }
        .onExitCommand { model.dismissSearch() }
        .onMoveCommand { direction in
            switch direction {
            case .up: model.moveSearchSelection(by: -1)
            case .down: model.moveSearchSelection(by: 1)
            default: break
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("搜索会话")
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(
                "搜索标题、用户消息与助手回复",
                text: Binding(
                    get: { model.searchQuery },
                    set: { model.updateSearchQuery($0) }
                )
            )
            .textFieldStyle(.plain)
            .font(.title3)
            .accessibilityLabel("搜索会话")
            .focused($searchFocused)
            .disabled(model.isOpeningSession)
            .defaultFocus($searchFocused, true)
            .onSubmit { Task { await model.openSelectedSearchResult() } }
            .onKeyPress(.upArrow) {
                model.moveSearchSelection(by: -1)
                return .handled
            }
            .onKeyPress(.downArrow) {
                model.moveSearchSelection(by: 1)
                return .handled
            }
            .onKeyPress(.escape) {
                model.dismissSearch()
                return .handled
            }
            Button("关闭搜索", systemImage: "xmark") {
                model.dismissSearch()
            }
            .labelStyle(.iconOnly)
            .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
            .buttonStyle(.plain)
            .dCodeAccessibleButton("关闭搜索")
            .disabled(model.isOpeningSession)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var filters: some View {
        HStack(spacing: 10) {
            Picker(
                "项目",
                selection: Binding(
                    get: { model.searchProjectID },
                    set: { model.selectSearchProject($0) }
                )
            ) {
                Text("全部可见会话").tag(Optional<UUID>.none)
                ForEach(model.projects) { project in
                    Text(project.name).tag(Optional(project.id))
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: 220, minHeight: PiDCodeMetrics.minimumTarget, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityLabel("项目筛选")
            .disabled(model.isOpeningSession)

            Picker(
                "源文件夹",
                selection: Binding(
                    get: { model.searchSourceFolderPath },
                    set: { model.selectSearchSourceFolder($0) }
                )
            ) {
                Text("全部源文件夹").tag(Optional<String>.none)
                ForEach(selectedProject?.sourceFolders ?? []) { folder in
                    Text(folder.displayName).tag(Optional(folder.path))
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: 220, minHeight: PiDCodeMetrics.minimumTarget, alignment: .leading)
            .contentShape(Rectangle())
            .disabled(selectedProject == nil || model.isOpeningSession)
            .accessibilityLabel("源文件夹筛选")

            Spacer(minLength: 0)
            indexStatus
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var resultContent: some View {
        if let error = model.searchError {
            ContentUnavailableView(
                "搜索暂不可用",
                systemImage: "exclamationmark.magnifyingglass",
                description: Text(error)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) {
                Button("重新建立索引") { model.presentSearch() }
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    .padding(.bottom, 18)
            }
        } else if model.isSearchQuerying {
            ContentUnavailableView(
                "正在搜索",
                systemImage: "magnifyingglass",
                description: Text("正在查询当前可见会话。")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.searchResults.isEmpty,
                  model.searchIndexStatus.state != .ready {
            ContentUnavailableView(
                model.searchIndexStatus.state == .rebuilding ? "正在重建搜索索引" : "正在建立搜索索引",
                systemImage: "text.magnifyingglass",
                description: Text("只读取 D Code 最近会话与已关联项目的当前会话路径。")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.searchResults.isEmpty {
            ContentUnavailableView.search(text: model.searchQuery)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                if let error = model.searchOpenError {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                            .accessibilityHidden(true)
                        Text(error)
                            .font(.callout)
                            .lineLimit(2)
                        Spacer(minLength: 8)
                        Button("关闭提示", systemImage: "xmark") {
                            model.clearSearchOpenError()
                        }
                        .labelStyle(.iconOnly)
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                        .buttonStyle(.plain)
                        .accessibilityLabel("关闭打开错误")
                    }
                    .padding(.leading, 14)
                    .padding(.trailing, 8)
                    .background(Color.orange.opacity(0.08))
                    .accessibilityElement(children: .combine)
                }
                searchResults
            }
        }
    }

    private var searchResults: some View {
        ScrollViewReader { proxy in
            ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(model.searchResults.enumerated()), id: \.element.id) { index, result in
                            Button {
                                Task { await model.openSearchResult(result) }
                            } label: {
                                SearchResultRow(
                                    result: result,
                                    ownership: model.ownership(for: result),
                                    selected: index == model.searchSelection
                                )
                            }
                            .buttonStyle(.plain)
                            .disabled(model.isStreaming || model.isOpeningSession)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(
                                result.accessibilityDescription(ownership: model.ownership(for: result))
                            )
                            .id(index)
                        }
                    }
                    .padding(8)
            }
            .onChange(of: model.searchSelection) { _, index in
                if reduceMotion { proxy.scrollTo(index) }
                else { withAnimation(.smooth(duration: 0.14)) { proxy.scrollTo(index) } }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            if model.isStreaming {
                Label("当前回复结束后可打开结果", systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            } else if model.isOpeningSession {
                Label("正在打开会话", systemImage: "progress.indicator")
                    .foregroundStyle(.secondary)
            } else {
                Text("↑↓ 选择 · ↩ 打开 · esc 关闭")
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Text("仅搜索可见会话")
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .frame(minHeight: PiDCodeMetrics.minimumTarget)
    }

    private var selectedProject: DCodeProject? {
        guard let id = model.searchProjectID else { return nil }
        return model.projects.first(where: { $0.id == id })
    }

    @ViewBuilder
    private var indexStatus: some View {
        switch model.searchIndexStatus.state {
        case .building, .updating, .rebuilding:
            HStack(spacing: 5) {
                ProgressView().controlSize(.small)
                if let progress = model.searchIndexStatus.progress, progress.total > 0 {
                    Text("\(progress.completed)/\(progress.total)")
                        .monospacedDigit()
                } else {
                    Text("准备中")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .failed:
            Label("索引失败", systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
        case .ready:
            Text("\(model.searchResults.count) 个会话")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .idle:
            EmptyView()
        }
    }
}

private struct SearchResultRow: View {
    let result: SessionSearchResult
    let ownership: SearchResultOwnership
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(result.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if result.matchCount > 1 {
                    Text("共 \(result.matchCount) 处")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let date = result.modifiedDate {
                    Text(date.piDCodeRelativeLabel)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            if !result.snippet.isEmpty, result.snippet != result.title {
                Text(result.snippet)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 5) {
                if let role = result.role {
                    Text(role == "user" ? "用户消息" : "助手回复")
                } else {
                    Text("会话标题")
                }
                Text("·")
                if let projectName = ownership.projectName,
                   let folderName = ownership.sourceFolderName {
                    Text("\(projectName) / \(folderName)")
                } else {
                    Text("未加入项目")
                }
                Text("·")
                Text(result.cwd)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(result.cwd)
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(
            selected ? Color.accentColor.opacity(0.14) : Color.clear,
            in: RoundedRectangle(cornerRadius: 9)
        )
        .overlay {
            if selected {
                RoundedRectangle(cornerRadius: 9)
                    .strokeBorder(Color.accentColor.opacity(0.28))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(result.accessibilityDescription(ownership: ownership))
    }
}
