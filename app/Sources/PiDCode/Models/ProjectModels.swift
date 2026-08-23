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
    var directory: SourceFolder

    /// 兼容既有读取器的单元素视图；新的 Project 不再拥有多个 Source Folder。
    var sourceFolders: [SourceFolder] { [directory] }

    init(id: UUID = UUID(), name: String, directory: SourceFolder) {
        self.id = id
        self.name = name
        self.directory = directory
    }

    init(id: UUID = UUID(), name: String, sourceFolders: [SourceFolder]) {
        precondition(sourceFolders.count == 1, "A D Code Project must have exactly one directory")
        self.init(id: id, name: name, directory: sourceFolders[0])
    }
}

enum ProjectSessionCreationRoute: Equatable, Sendable {
    case direct(SourceFolder)

    static func resolve(for project: DCodeProject) -> Self {
        .direct(project.directory)
    }
}

struct ProjectSessionOwnership: Equatable, Sendable {
    let project: DCodeProject
    let sourceFolder: SourceFolder
}

enum ProjectSessionOwnershipResolver {
    static func resolve(
        cwd: String,
        projects: [DCodeProject]
    ) -> ProjectSessionOwnership? {
        let canonicalCwd = canonicalPath(cwd)
        for project in projects {
            if canonicalPath(project.directory.path) == canonicalCwd {
                return ProjectSessionOwnership(project: project, sourceFolder: project.directory)
            }
        }
        return nil
    }

    private static func canonicalPath(_ path: String) -> String {
        URL(fileURLWithPath: path, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
    }
}

struct ProjectFolderConflict: Hashable, Identifiable, Sendable {
    let path: String
    let projectID: UUID
    let projectName: String

    var id: String { "\(projectID.uuidString):\(path)" }
}

struct ProjectDocument: Codable, Equatable, Sendable {
    static let currentVersion = 2

    let version: Int
    var projects: [DCodeProject]

    init(projects: [DCodeProject]) {
        version = Self.currentVersion
        self.projects = projects
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case projects
    }

    private struct LegacyProject: Decodable {
        let id: UUID
        let name: String
        let sourceFolders: [SourceFolder]
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let storedVersion = try container.decode(Int.self, forKey: .version)
        switch storedVersion {
        case Self.currentVersion:
            version = Self.currentVersion
            projects = try container.decode([DCodeProject].self, forKey: .projects)
        case 1:
            let legacy = try container.decode([LegacyProject].self, forKey: .projects)
            version = Self.currentVersion
            projects = try legacy.flatMap { project in
                guard !project.sourceFolders.isEmpty else {
                    throw ProjectStoreError.legacyProjectMissingDirectory(project.name)
                }
                return project.sourceFolders.enumerated().map { index, folder in
                    DCodeProject(
                        id: index == 0 ? project.id : UUID(),
                        name: index == 0 ? project.name : "\(project.name) · \(folder.displayName)",
                        directory: folder
                    )
                }
            }
        default:
            throw ProjectStoreError.invalidDocumentVersion(storedVersion)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.currentVersion, forKey: .version)
        try container.encode(projects, forKey: .projects)
    }
}

enum ProjectStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case invalidDirectory(String)
    case duplicateProjectID(UUID)
    case duplicateFolder(String)
    case directoryAlreadyAssigned(ProjectFolderConflict)
    case legacyProjectMissingDirectory(String)
    case invalidProjectName
    case hostUnavailable
    case directoryMigrationRecoveryRequired
    case unavailableAfterLoadFailure
    case mutationBlockedDuringSessionCopy

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "项目资料版本 \(version) 暂不受支持；原文件已保留。"
        case let .invalidDirectory(path):
            "项目目录不存在、不可访问或不是目录：\(path)"
        case let .duplicateProjectID(id):
            "项目资料包含重复的项目 ID：\(id.uuidString)；原文件已保留。"
        case let .duplicateFolder(path):
            "同一项目目录不能重复归属：\(path)"
        case let .directoryAlreadyAssigned(conflict):
            "目录“\(URL(fileURLWithPath: conflict.path).lastPathComponent)”已经属于项目“\(conflict.projectName)”。"
        case let .legacyProjectMissingDirectory(name):
            "旧项目“\(name)”没有可迁移的目录；原项目资料已保留。"
        case .invalidProjectName:
            "请输入项目名称。"
        case .hostUnavailable:
            "Pi Host 尚未准备好，暂时不能迁移项目目录。"
        case .directoryMigrationRecoveryRequired:
            "会话工作目录已经迁移，但项目资料未能安全保存且自动回退失败。请停止继续操作，先核对项目目录和会话文件。"
        case .unavailableAfterLoadFailure:
            "项目资料尚未安全载入；为保留原文件，本次不允许写入。"
        case .mutationBlockedDuringSessionCopy:
            "会话复制期间不能修改 Project 目录；请等待复制完成。"
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

    static func canonicalDirectoryPathIfAvailable(_ url: URL) -> String? {
        try? canonicalDirectoryPath(url)
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
                requested.contains(ownershipKey(project.directory.path))
                    ? [ProjectFolderConflict(path: project.directory.path, projectID: project.id, projectName: project.name)]
                    : []
            }
    }

    static func applying(
        projectID: UUID?,
        name: String,
        directoryURL: URL,
        to projects: [DCodeProject]
    ) throws -> (projects: [DCodeProject], savedProjectID: UUID) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { throw ProjectStoreError.invalidProjectName }

        let canonicalDirectory = try canonicalDirectoryPath(directoryURL)
        let conflicts = conflicts(paths: [canonicalDirectory], in: projects, excluding: projectID)
        if let conflict = conflicts.first { throw ProjectStoreError.directoryAlreadyAssigned(conflict) }

        let savedProjectID = projectID ?? UUID()
        let updated = DCodeProject(id: savedProjectID, name: trimmedName, directory: SourceFolder(path: canonicalDirectory))

        var result = projects.map { project in
            project.id == savedProjectID ? updated : project
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
        for path in projects.map(\.directory.path) {
            guard seen.insert(ownershipKey(path)).inserted else { throw ProjectStoreError.duplicateFolder(path) }
        }
    }

    private static func ownershipKey(_ path: String) -> String {
        let url = URL(fileURLWithPath: path, isDirectory: true)
        return (try? canonicalDirectoryPath(url)) ?? url.standardizedFileURL.path
    }
}
