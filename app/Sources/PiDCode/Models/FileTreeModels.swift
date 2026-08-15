import Foundation

enum ProjectFileKind: String, Hashable, Sendable {
    case directory
    case file
    case symbolicLink
    case other
}

struct ProjectFileNode: Hashable, Identifiable, Sendable {
    let path: String
    let name: String
    let kind: ProjectFileKind

    var id: String { path }
    var isExpandable: Bool { kind == .directory }
}

enum ProjectFileTreeLayout: Equatable, Sendable {
    case empty
    case flattened(SourceFolder)
    case grouped([SourceFolder])

    static func resolve(for project: DCodeProject) -> ProjectFileTreeLayout {
        switch project.sourceFolders.count {
        case 0:
            .empty
        case 1:
            .flattened(project.sourceFolders[0])
        default:
            .grouped(project.sourceFolders)
        }
    }
}

enum FileTreeReaderError: LocalizedError, Equatable {
    case outsideSourceFolder
    case symbolicLinkNotExpandable

    var errorDescription: String? {
        switch self {
        case .outsideSourceFolder: "该目录已经离开源文件夹范围，已停止读取。"
        case .symbolicLinkNotExpandable: "符号链接只显示位置，不会递归展开。"
        }
    }
}

enum FileTreeReader {
    static func children(rootPath: String, directoryPath: String) async throws -> [ProjectFileNode] {
        try await Task.detached(priority: .utility) {
            let root = URL(fileURLWithPath: rootPath, isDirectory: true)
                .standardizedFileURL.resolvingSymlinksInPath()
            let requested = URL(fileURLWithPath: directoryPath, isDirectory: true).standardizedFileURL
            let requestedValues = try requested.resourceValues(forKeys: [.isSymbolicLinkKey])
            if requestedValues.isSymbolicLink == true { throw FileTreeReaderError.symbolicLinkNotExpandable }
            let canonical = requested.resolvingSymlinksInPath()
            guard isContained(canonical, by: root) else { throw FileTreeReaderError.outsideSourceFolder }

            let keys: Set<URLResourceKey> = [.nameKey, .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
            let urls = try FileManager.default.contentsOfDirectory(
                at: canonical,
                includingPropertiesForKeys: Array(keys),
                options: []
            )
            return try urls.map { url in
                let values = try url.resourceValues(forKeys: keys)
                let kind: ProjectFileKind
                if values.isSymbolicLink == true { kind = .symbolicLink }
                else if values.isDirectory == true { kind = .directory }
                else if values.isRegularFile == true { kind = .file }
                else { kind = .other }
                return ProjectFileNode(path: url.path, name: values.name ?? url.lastPathComponent, kind: kind)
            }.sorted { lhs, rhs in
                if lhs.isExpandable != rhs.isExpandable { return lhs.isExpandable }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
        }.value
    }

    private static func isContained(_ candidate: URL, by root: URL) -> Bool {
        let rootComponents = root.standardizedFileURL.pathComponents
        let candidateComponents = candidate.standardizedFileURL.pathComponents
        return candidateComponents.count >= rootComponents.count
            && Array(candidateComponents.prefix(rootComponents.count)) == rootComponents
    }
}
