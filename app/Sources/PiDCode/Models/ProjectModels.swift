import Foundation

struct SourceFolder: Codable, Hashable, Identifiable, Sendable {
    let path: String

    init(path: String) {
        self.path = path
    }

    var id: String { path }

    var url: URL { URL(fileURLWithPath: path, isDirectory: true) }

    var displayName: String {
        let name = url.lastPathComponent
        return name.isEmpty ? path : name
    }
}

struct DCodeProject: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    var name: String
    var sourceFolders: [SourceFolder]

    init(id: UUID = UUID(), name: String, sourceFolders: [SourceFolder]) {
        self.id = id
        self.name = name
        self.sourceFolders = sourceFolders
    }
}

struct ProjectFolderConflict: Hashable, Identifiable, Sendable {
    let path: String
    let projectID: UUID
    let projectName: String

    var id: String { "\(projectID.uuidString):\(path)" }
}

struct ProjectDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    var projects: [DCodeProject]

    init(projects: [DCodeProject]) {
        version = Self.currentVersion
        self.projects = projects
    }
}

enum ProjectStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case invalidDirectory(String)
    case duplicateProjectID(UUID)
    case duplicateFolder(String)
    case missingMoveConfirmation([ProjectFolderConflict])
    case invalidProjectName
    case unavailableAfterLoadFailure
    case mutationBlockedDuringSessionCopy

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "项目资料版本 \(version) 暂不受支持；原文件已保留。"
        case let .invalidDirectory(path):
            "源文件夹不存在、不可访问或不是目录：\(path)"
        case let .duplicateProjectID(id):
            "项目资料包含重复的项目 ID：\(id.uuidString)；原文件已保留。"
        case let .duplicateFolder(path):
            "同一源文件夹不能重复归属：\(path)"
        case let .missingMoveConfirmation(conflicts):
            "有 \(conflicts.count) 个源文件夹已经属于其他项目，需要明确确认移动。"
        case .invalidProjectName:
            "请输入项目名称。"
        case .unavailableAfterLoadFailure:
            "项目资料尚未安全载入；为保留原文件，本次不允许写入。"
        case .mutationBlockedDuringSessionCopy:
            "会话复制期间不能修改 Project 或 Source Folder；请等待复制完成。"
        }
    }
}

actor ProjectStore {
    nonisolated let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_PROJECT_STORE_PATH"], !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "projects-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> [DCodeProject] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let data = try Data(contentsOf: fileURL)
        let document = try JSONDecoder().decode(ProjectDocument.self, from: data)
        guard document.version == ProjectDocument.currentVersion else {
            throw ProjectStoreError.invalidDocumentVersion(document.version)
        }
        try Self.validateUniqueFolders(document.projects)
        return document.projects
    }

    func save(_ projects: [DCodeProject]) throws {
        try Self.validateUniqueFolders(projects)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(ProjectDocument(projects: projects))
        try data.write(to: fileURL, options: [.atomic])
    }

    static func canonicalDirectoryPath(_ url: URL) throws -> String {
        let standardized = url.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory = ObjCBool(false)
        guard FileManager.default.fileExists(atPath: standardized.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ProjectStoreError.invalidDirectory(url.path)
        }
        return standardized.path
    }

    static func conflicts(
        paths: [String],
        in projects: [DCodeProject],
        excluding projectID: UUID?
    ) -> [ProjectFolderConflict] {
        let requested = Set(paths.map(ownershipKey))
        return projects
            .filter { $0.id != projectID }
            .flatMap { project in
                project.sourceFolders.compactMap { folder in
                    requested.contains(ownershipKey(folder.path))
                        ? ProjectFolderConflict(path: folder.path, projectID: project.id, projectName: project.name)
                        : nil
                }
            }
    }

    static func applying(
        projectID: UUID?,
        name: String,
        folderURLs: [URL],
        to projects: [DCodeProject],
        moveConflicts: Bool
    ) throws -> (projects: [DCodeProject], savedProjectID: UUID) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { throw ProjectStoreError.invalidProjectName }

        var canonicalPaths: [String] = []
        for url in folderURLs {
            let path = try canonicalDirectoryPath(url)
            if !canonicalPaths.contains(path) { canonicalPaths.append(path) }
        }

        let conflicts = conflicts(paths: canonicalPaths, in: projects, excluding: projectID)
        if !conflicts.isEmpty, !moveConflicts {
            throw ProjectStoreError.missingMoveConfirmation(conflicts)
        }

        let savedProjectID = projectID ?? UUID()
        let folders = canonicalPaths.map(SourceFolder.init(path:))
        let updated = DCodeProject(id: savedProjectID, name: trimmedName, sourceFolders: folders)
        let requestedOwnership = Set(canonicalPaths.map(ownershipKey))

        var result = projects.map { project -> DCodeProject in
            guard project.id != savedProjectID else { return updated }
            guard moveConflicts else { return project }
            var mutable = project
            mutable.sourceFolders.removeAll { requestedOwnership.contains(ownershipKey($0.path)) }
            return mutable
        }
        if !result.contains(where: { $0.id == savedProjectID }) { result.append(updated) }
        try validateUniqueFolders(result)
        return (result, savedProjectID)
    }

    private static func validateUniqueFolders(_ projects: [DCodeProject]) throws {
        var projectIDs = Set<UUID>()
        for project in projects {
            guard projectIDs.insert(project.id).inserted else {
                throw ProjectStoreError.duplicateProjectID(project.id)
            }
        }
        var seen = Set<String>()
        for path in projects.flatMap(\.sourceFolders).map(\.path) {
            guard seen.insert(ownershipKey(path)).inserted else { throw ProjectStoreError.duplicateFolder(path) }
        }
    }

    private static func ownershipKey(_ path: String) -> String {
        let url = URL(fileURLWithPath: path, isDirectory: true)
        return (try? canonicalDirectoryPath(url)) ?? url.standardizedFileURL.path
    }
}
