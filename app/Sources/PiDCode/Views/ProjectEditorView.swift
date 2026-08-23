import AppKit
import SwiftUI

struct ProjectEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: DCodeProject?

    @State private var name: String
    @State private var directoryURL: URL?
    @State private var conflict: ProjectFolderConflict?
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var moveFilesWithDirectory = false

    init(project: DCodeProject?) {
        self.project = project
        _name = State(initialValue: project?.name ?? "")
        _directoryURL = State(initialValue: project?.directory.url)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text(project == nil ? "新建项目" : "编辑项目")
                    .font(.title2.weight(.semibold))
                Text("一个项目对应一个工作目录；修改目录时会迁移关联会话的工作目录。")
                    .foregroundStyle(.secondary)
            }

            TextField("项目名称", text: $name)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("项目名称")
                .disabled(isSaving)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("项目目录")
                        .font(.headline)
                    Spacer()
                    Button(directoryURL == nil ? "选择目录…" : "更换目录…", action: chooseDirectory)
                        .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                        .dCodeAccessibleButton("选择项目目录")
                        .disabled(isSaving)
                }
                if let directoryURL {
                    HStack(spacing: 10) {
                        Image(systemName: "folder")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(directoryURL.lastPathComponent)
                            Text(directoryURL.path)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                    }
                    .padding(12)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
                } else {
                    Text("选择一个目录后，D Code 会将该项目及其会话关联到这里。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
                }
            }

            if let conflict {
                VStack(alignment: .leading, spacing: 6) {
                    Label("该目录已经属于其他项目", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.semibold))
                    Text("“\(URL(fileURLWithPath: conflict.path).lastPathComponent)”目前属于“\(conflict.projectName)”。")
                        .font(.caption)
                    Text("一个目录只能属于一个项目；请先在原项目中迁移或更换目录。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(12)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
            }

            if project != nil, directoryChanged {
                Toggle("同时迁移目录内文件", isOn: $moveFilesWithDirectory)
                    .disabled(isSaving)
                Text(moveFilesWithDirectory
                    ? "保存时会直接改写关联会话的 cwd，并迁移目录内文件。目标目录必须为空，现有文件不会被覆盖。"
                    : "保存时只会直接改写关联会话的 cwd；目录内文件保持原处。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("取消", role: .cancel) { dismiss() }
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                    .dCodeAccessibleButton("取消编辑项目")
                    .disabled(isSaving)
                Spacer()
                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("正在迁移项目目录")
                }
                Button(project != nil && directoryChanged ? "修改并迁移" : "保存") {
                    save()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || directoryURL == nil
                        || conflict != nil
                        || isSaving
                )
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                .dCodeAccessibleButton(project != nil && directoryChanged ? "修改项目目录并迁移" : "保存项目")
            }
        }
        .padding(24)
        .frame(width: 560)
        .interactiveDismissDisabled(isSaving)
    }

    private var directoryChanged: Bool {
        guard let project, let directoryURL,
              let existing = try? ProjectStore.canonicalDirectoryPath(project.directory.url),
              let selected = try? ProjectStore.canonicalDirectoryPath(directoryURL) else { return project != nil }
        return existing != selected
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.title = "选择项目目录"
        panel.prompt = "选择"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            directoryURL = url
            conflict = nil
            errorMessage = nil
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                guard let directoryURL else {
                    isSaving = false
                    return
                }
                if let currentConflict = try model.projectDirectoryConflict(
                    directoryURL: directoryURL,
                    excluding: project?.id
                ) {
                    conflict = currentConflict
                    isSaving = false
                    return
                }
                if let project, directoryChanged {
                    _ = try await model.migrateProjectDirectory(
                        id: project.id,
                        name: name,
                        directoryURL: directoryURL,
                        moveFiles: moveFilesWithDirectory
                    )
                } else {
                    _ = try await model.saveProject(
                        id: project?.id,
                        name: name,
                        directoryURL: directoryURL
                    )
                }
                dismiss()
            } catch {
                errorMessage = DiagnosticSanitizer.redact(error.localizedDescription)
                isSaving = false
            }
        }
    }
}
