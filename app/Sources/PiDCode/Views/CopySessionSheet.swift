import SwiftUI

struct CopySessionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let mode: SessionCopyMode
    let editProject: (DCodeProject?) -> Void

    @State private var projectID: UUID?
    @State private var projectDirectoryPath: String?

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
                    Text("先创建 Project，再把会话复制到它的项目目录。")
                } actions: {
                    Button("创建项目") { openProjectEditor(nil) }
                        .frame(minHeight: PiDCodeMetrics.compactControlHeight)
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
                    if let projectDirectoryPath {
                        LabeledContent("项目目录") {
                            Text(projectDirectoryPath)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(2)
                        }
                        if !targetFolderIsValid {
                            HStack {
                                Text("这个项目目录已失效或真实路径发生变化。")
                                    .foregroundStyle(.orange)
                                Spacer()
                                Button("修复项目目录") { openProjectEditor(selectedProject) }
                                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                            }
                        }
                    }
                    if let selectedProject {
                        HStack {
                            Spacer()
                            Button("编辑目标项目…") { openProjectEditor(selectedProject) }
                                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                        }
                    }
                    if mode == .copyAndArchive {
                        if model.pendingArchiveRetry != nil {
                            Text("请先前往“设置 > 会话 > 已归档会话”完成上一次待重试归档；普通复制仍可使用。")
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
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                    .disabled(model.isCopyingSession)
                Spacer()
                if model.isCopyingSession { ProgressView().controlSize(.small) }
                Button(mode == .copy ? "复制" : "复制并归档") {
                    guard let projectDirectoryPath, let projectID else { return }
                    Task {
                        if await model.copySelectedSession(
                            to: URL(fileURLWithPath: projectDirectoryPath, isDirectory: true),
                            in: projectID,
                            archiveSource: mode == .copyAndArchive
                        ) { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                .disabled(!canSubmit || model.isCopyingSession)
            }
        }
        .padding(20)
        .frame(minWidth: 620, minHeight: 430)
        .interactiveDismissDisabled(model.isCopyingSession)
        .onAppear { selectFirstAvailableTarget() }
        .onChange(of: projectID) { _, _ in selectProjectDirectory() }
    }

    private var selectedProject: DCodeProject? {
        guard let projectID else { return nil }
        return model.projects.first(where: { $0.id == projectID })
    }

    private var canSubmit: Bool {
        guard let projectDirectoryPath else { return false }
        if mode == .copyAndArchive, model.pendingArchiveRetry != nil { return false }
        if mode == .copyAndArchive, sourceIsArchived { return false }
        return selectedProject?.directory.path == projectDirectoryPath
            && targetFolderIsValid
    }

    private var targetFolderIsValid: Bool {
        guard let projectDirectoryPath else { return false }
        let url = URL(fileURLWithPath: projectDirectoryPath, isDirectory: true)
        return (try? ProjectStore.canonicalDirectoryPath(url)) == projectDirectoryPath
    }

    private var sourceIsArchived: Bool {
        guard let selectedSessionID = model.selectedSessionID else { return false }
        return model.archivedSessions.contains(where: { $0.sessionID == selectedSessionID })
    }

    private func selectFirstAvailableTarget() {
        if projectID == nil { projectID = model.projects.first?.id }
        selectProjectDirectory()
    }

    private func selectProjectDirectory() {
        projectDirectoryPath = selectedProject?.directory.path
    }

    private func openProjectEditor(_ project: DCodeProject?) {
        editProject(project)
    }
}
