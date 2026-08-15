import AppKit
import SwiftUI

struct ProjectEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: DCodeProject?

    @State private var name: String
    @State private var folderURLs: [URL]
    @State private var conflicts: [ProjectFolderConflict] = []
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(project: DCodeProject?) {
        self.project = project
        _name = State(initialValue: project?.name ?? "")
        _folderURLs = State(initialValue: project?.sourceFolders.map(\.url) ?? [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text(project == nil ? "新建项目" : "编辑项目")
                    .font(.title2.weight(.semibold))
                Text("项目只组织源文件夹和已有 Pi 会话，不移动或修改真实文件。")
                    .foregroundStyle(.secondary)
            }

            TextField("项目名称", text: $name)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("项目名称")

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("源文件夹")
                        .font(.headline)
                    Spacer()
                    Button("添加文件夹…", action: chooseFolders)
                        .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                        .dCodeAccessibleButton("添加源文件夹")
                }
                if folderURLs.isEmpty {
                    Text("至少添加一个源文件夹，之后可继续编辑项目。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
                } else {
                    List {
                        ForEach(folderURLs, id: \.path) { url in
                            HStack(spacing: 10) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(url.lastPathComponent)
                                    Text(url.path)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer()
                                Button {
                                    folderURLs.removeAll { $0.path == url.path }
                                    conflicts = []
                                } label: {
                                    IconActionGlyph(systemName: "minus.circle")
                                }
                                .buttonStyle(IconActionStyle())
                                .dCodeAccessibleButton("移除源文件夹 \(url.lastPathComponent)")
                            }
                        }
                    }
                    .frame(minHeight: 150, maxHeight: 250)
                }
            }

            if !conflicts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("以下文件夹已经属于其他项目", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.semibold))
                    ForEach(conflicts) { conflict in
                        Text("“\(URL(fileURLWithPath: conflict.path).lastPathComponent)”目前属于“\(conflict.projectName)”")
                            .font(.caption)
                    }
                    Text("再次选择“移动并保存”才会改变归属；真实文件与 Git 不会移动。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(12)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
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
                Spacer()
                Button(conflicts.isEmpty ? "保存" : "移动并保存") {
                    save(moveConflicts: !conflicts.isEmpty)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || folderURLs.isEmpty
                        || isSaving
                )
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                .dCodeAccessibleButton(conflicts.isEmpty ? "保存项目" : "移动源文件夹并保存项目")
            }
        }
        .padding(24)
        .frame(width: 560)
    }

    private func chooseFolders() {
        let panel = NSOpenPanel()
        panel.title = "添加源文件夹"
        panel.prompt = "添加"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = true
        panel.begin { response in
            guard response == .OK else { return }
            for url in panel.urls where !folderURLs.contains(where: { $0.path == url.path }) {
                folderURLs.append(url)
            }
            conflicts = []
            errorMessage = nil
        }
    }

    private func save(moveConflicts: Bool) {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                let currentConflicts = try model.projectFolderConflicts(
                    folderURLs: folderURLs,
                    excluding: project?.id
                )
                if !currentConflicts.isEmpty, !moveConflicts {
                    conflicts = currentConflicts
                    isSaving = false
                    return
                }
                _ = try await model.saveProject(
                    id: project?.id,
                    name: name,
                    folderURLs: folderURLs,
                    moveConflicts: moveConflicts
                )
                dismiss()
            } catch {
                errorMessage = DiagnosticSanitizer.redact(error.localizedDescription)
                isSaving = false
            }
        }
    }
}
