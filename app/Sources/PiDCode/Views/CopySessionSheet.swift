import SwiftUI

struct CopySessionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let mode: SessionCopyMode
    let editProject: (DCodeProject?) -> Void

    @State private var projectID: UUID?
    @State private var sourceFolderPath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(mode == .copy ? "复制到项目" : "复制到项目并归档原会话")
                        .font(.title2.weight(.semibold))
                    Text("将完整已持久化会话复制成新的 Session ID；原 Pi 会话不会被删除或改写。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if model.projects.isEmpty {
                ContentUnavailableView {
                    Label("还没有项目", systemImage: "folder.badge.plus")
                } description: {
                    Text("先创建 Project，再把会话复制到它的 Source Folder。")
                } actions: {
                    Button("创建项目") { openProjectEditor(nil) }
                        .frame(minHeight: PiDCodeMetrics.minimumTarget)
                        .disabled(model.isCopyingSession)
                }
            } else {
                Form {
                    Picker("目标项目", selection: $projectID) {
                        Text("请选择").tag(UUID?.none)
                        ForEach(model.projects) { project in
                            Text(project.name).tag(Optional(project.id))
                        }
                    }
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    Picker("Source Folder", selection: $sourceFolderPath) {
                        Text("请选择").tag(String?.none)
                        ForEach(selectedProject?.sourceFolders ?? []) { folder in
                            Text(folder.displayName).tag(Optional(folder.path))
                        }
                    }
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    if let sourceFolderPath {
                        LabeledContent("最终 cwd") {
                            Text(sourceFolderPath)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(2)
                        }
                        if !targetFolderIsValid {
                            HStack {
                                Text("这个 Source Folder 已失效或真实路径发生变化。")
                                    .foregroundStyle(.orange)
                                Spacer()
                                Button("修复 Source Folder") { openProjectEditor(selectedProject) }
                                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                            }
                        }
                    }
                    if selectedProject?.sourceFolders.isEmpty == true {
                        HStack {
                            Text("该项目还没有 Source Folder。")
                                .foregroundStyle(.orange)
                            Spacer()
                            Button("添加 Source Folder") { openProjectEditor(selectedProject) }
                                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                        }
                    } else if let selectedProject {
                        HStack {
                            Spacer()
                            Button("编辑目标项目…") { openProjectEditor(selectedProject) }
                                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                        }
                    }
                    if mode == .copyAndArchive {
                        if model.pendingArchiveRetry != nil {
                            Text("请先从“已归档会话”完成上一次待重试归档；普通复制仍可使用。")
                                .font(.callout)
                                .foregroundStyle(.orange)
                        }
                        if sourceIsArchived {
                            Text("原会话已经归档；如需再创建副本，请使用普通“复制到项目”。")
                                .font(.callout)
                                .foregroundStyle(.orange)
                        }
                        Text("复制目标完整发布并验证可打开后，原会话才会从 D Code 的 Recent、Project 和 Search 中归档；Pi CLI 仍可访问原会话。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .formStyle(.grouped)
                .disabled(model.isCopyingSession)
            }

            HStack {
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    .disabled(model.isCopyingSession)
                Spacer()
                if model.isCopyingSession { ProgressView().controlSize(.small) }
                Button(mode == .copy ? "复制" : "复制并归档") {
                    guard let sourceFolderPath, let projectID else { return }
                    Task {
                        if await model.copySelectedSession(
                            to: URL(fileURLWithPath: sourceFolderPath, isDirectory: true),
                            in: projectID,
                            archiveSource: mode == .copyAndArchive
                        ) { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                .disabled(!canSubmit || model.isCopyingSession)
            }
        }
        .padding(20)
        .frame(minWidth: 620, minHeight: 430)
        .interactiveDismissDisabled(model.isCopyingSession)
        .onAppear { selectFirstAvailableTarget() }
        .onChange(of: projectID) { _, _ in selectFirstFolder() }
    }

    private var selectedProject: DCodeProject? {
        guard let projectID else { return nil }
        return model.projects.first(where: { $0.id == projectID })
    }

    private var canSubmit: Bool {
        guard let sourceFolderPath else { return false }
        if mode == .copyAndArchive, model.pendingArchiveRetry != nil { return false }
        if mode == .copyAndArchive, sourceIsArchived { return false }
        return selectedProject?.sourceFolders.contains(where: { $0.path == sourceFolderPath }) == true
            && targetFolderIsValid
    }

    private var targetFolderIsValid: Bool {
        guard let sourceFolderPath else { return false }
        let url = URL(fileURLWithPath: sourceFolderPath, isDirectory: true)
        return (try? ProjectStore.canonicalDirectoryPath(url)) == sourceFolderPath
    }

    private var sourceIsArchived: Bool {
        guard let selectedSessionID = model.selectedSessionID else { return false }
        return model.archivedSessions.contains(where: { $0.sessionID == selectedSessionID })
    }

    private func selectFirstAvailableTarget() {
        if projectID == nil { projectID = model.projects.first?.id }
        selectFirstFolder()
    }

    private func selectFirstFolder() {
        let folders = selectedProject?.sourceFolders ?? []
        sourceFolderPath = folders.count == 1 ? folders[0].path : nil
    }

    private func openProjectEditor(_ project: DCodeProject?) {
        editProject(project)
    }
}
