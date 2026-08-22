import CryptoKit
import Darwin
import Foundation

struct WorkspaceFileSnapshot: Equatable, Sendable {
    let path: String
    let sourceFolderPath: String
    let relativePath: String
    let text: String
    let byteCount: Int
    /// 磁盘内容 SHA-256（十六进制）；保存前的冲突校验以它为基准（ADR 0025）。
    let contentDigest: String
    let loadedAt: Date
}

struct WorkspaceFileTab: Identifiable, Equatable, Sendable {
    var id: String { path }

    let path: String
    var sourceFolderPath: String
    var requestedLine: Int?
    var snapshot: WorkspaceFileSnapshot?
    var errorMessage: String?
    var isLoading: Bool
    var authorizationAvailable: Bool
    /// 编辑缓冲区（ADR 0025）：仅在用户显式进入编辑后存在；nil 表示只读呈现。
    var draft: WorkspaceFileDraft?
    var viewMode: WorkspaceFileViewMode = .preview

    var title: String {
        URL(fileURLWithPath: path).lastPathComponent
    }
}

enum WorkspaceFileViewMode: Equatable, Sendable {
    case preview
    case source
}

/// Markdown 编辑缓冲区：内存态、身份随标签（ADR 0025 决定 3）。
struct WorkspaceFileDraft: Equatable, Sendable {
    var text: String
    /// 上次加载或保存成功时的文本，`text` 与它的差异即未保存修改。
    var baseText: String
    /// 上次加载或保存成功时的磁盘内容 SHA-256，保存前据此校验磁盘现状。
    var baseDigest: String
    var isSaving: Bool = false
    var isConflicted: Bool = false
    var failureMessage: String?

    var isDirty: Bool { text != baseText }
}

enum WorkspaceFileEditPolicy {
    /// 0.0.17 编辑范围仅限 Markdown（ADR 0025 决定 2）；通用代码编辑由路线图排除。
    static func isEditableMarkdown(path: String) -> Bool {
        URL(fileURLWithPath: path).pathExtension.lowercased() == "md"
    }

    /// 0.0.18 HTML 编辑（ADR 0026 决定 1）：复用 0025 缓冲区与保存模型。
    static func isEditableHTML(path: String) -> Bool {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        return ext == "html" || ext == "htm"
    }
}

enum WorkspaceTabSelection: Equatable, Sendable {
    case conversation
    case file(String)
}

enum WorkspaceTabNavigation {
    static func showsFileTabStrip(fileCount: Int) -> Bool {
        fileCount > 0
    }

    static func selectionAfterClosing(
        path: String,
        tabs: [WorkspaceFileTab],
        current: WorkspaceTabSelection
    ) -> WorkspaceTabSelection {
        guard current == .file(path),
              let closingIndex = tabs.firstIndex(where: { $0.path == path }) else {
            return current
        }
        let remaining = tabs.filter { $0.path != path }
        if remaining.indices.contains(closingIndex) {
            return .file(remaining[closingIndex].path)
        }
        if let previous = remaining.last {
            return .file(previous.path)
        }
        return .conversation
    }
}

enum WorkspaceFileAuthorization {
    static func registeredSourceFolder(
        matching sourceFolderPath: String,
        projects: [DCodeProject]
    ) -> SourceFolder? {
        let requested = WorkspaceFileReader.standardizedAbsolutePath(sourceFolderPath)
        return projects
            .flatMap(\.sourceFolders)
            .first(where: {
                WorkspaceFileReader.standardizedAbsolutePath($0.path) == requested
            })
    }

    static func registeredSourceFolder(
        containing filePath: String,
        projects: [DCodeProject]
    ) -> SourceFolder? {
        let candidate = WorkspaceFileReader.standardizedAbsolutePath(filePath)
        return projects
            .flatMap(\.sourceFolders)
            .sorted { $0.path.count > $1.path.count }
            .first(where: { folder in
                let root = WorkspaceFileReader.standardizedAbsolutePath(folder.path)
                return WorkspaceFileReader.relativeComponents(of: candidate, inside: root) != nil
            })
    }
}

enum WorkspaceFileDigest {
    static func sha256Hex(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// 共享的安全路径遍历（ADR 0025 决定 1）：读取与写入走同一套从 `/` 逐级
/// `openat`、全程 `O_NOFOLLOW` 的实现，符号链接与越出授权根对两条路径同样失败关闭。
enum WorkspaceFileSecurePathError: Error, Equatable, Sendable {
    case outsideSourceFolder
    case symbolicLink
    case notRegularFile
    case cannotOpen
}

enum WorkspaceFileSecurePath {
    /// 逐级打开到 rootPath，再逐级打开 relativeComponents（全部必须存在且为目录），
    /// 返回最终目录描述符；调用方负责 `close`。任一环节失败即关闭已打开的描述符。
    static func openParentDirectory(rootPath: String, relativeComponents: [String]) throws -> Int32 {
        var directoryDescriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directoryDescriptor >= 0 else { throw WorkspaceFileSecurePathError.cannotOpen }
        do {
            let rootComponents = URL(fileURLWithPath: rootPath).standardizedFileURL.pathComponents
                .filter { $0 != "/" }
            for component in rootComponents {
                directoryDescriptor = try openNext(component, from: directoryDescriptor)
            }
            for component in relativeComponents {
                directoryDescriptor = try openNext(component, from: directoryDescriptor)
            }
            return directoryDescriptor
        } catch {
            Darwin.close(directoryDescriptor)
            throw error
        }
    }

    /// 在目录内以 `O_NOFOLLOW` 只读打开既有普通文件；不存在返回 nil，
    /// 符号链接与目录冒充按 `WorkspaceFileSecurePathError` 分类。
    static func openExistingFile(directoryDescriptor: Int32, filename: String) throws -> Int32? {
        let fileDescriptor = Darwin.openat(
            directoryDescriptor,
            filename,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        if fileDescriptor >= 0 { return fileDescriptor }
        if errno == ENOENT { return nil }
        throw classifyOpenError(
            directoryDescriptor: directoryDescriptor,
            component: filename,
            openError: errno
        )
    }

    static func classifyOpenError(
        directoryDescriptor: Int32,
        component: String,
        openError: Int32
    ) -> WorkspaceFileSecurePathError {
        if openError == ELOOP { return .symbolicLink }
        if isSymbolicLink(directoryDescriptor, component) { return .symbolicLink }
        return .cannotOpen
    }

    private static func isSymbolicLink(_ directoryDescriptor: Int32, _ component: String) -> Bool {
        var metadata = stat()
        return Darwin.fstatat(
            directoryDescriptor,
            component,
            &metadata,
            AT_SYMLINK_NOFOLLOW
        ) == 0 && metadata.st_mode & S_IFMT == S_IFLNK
    }

    private static func openNext(_ component: String, from parent: Int32) throws -> Int32 {
        let next = Darwin.openat(
            parent,
            component,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard next >= 0 else {
            throw classifyOpenError(
                directoryDescriptor: parent,
                component: component,
                openError: errno
            )
        }
        Darwin.close(parent)
        return next
    }
}

enum WorkspaceFileReaderError: LocalizedError, Equatable {
    case outsideSourceFolder
    case symbolicLink
    case notRegularFile
    case fileTooLarge(maximumBytes: Int)
    case invalidTextEncoding
    case binaryFile
    case changedWhileReading
    case cannotOpen
    case cannotRead

    var errorDescription: String? {
        switch self {
        case .outsideSourceFolder:
            "该文件不在当前登记的源文件夹内，已停止读取。"
        case .symbolicLink:
            "该路径包含符号链接。为避免越过项目边界，D Code 不会读取。"
        case .notRegularFile:
            "该位置不是可预览的普通文件。"
        case let .fileTooLarge(maximumBytes):
            "文件超过只读预览上限（\(ByteCountFormatter.string(fromByteCount: Int64(maximumBytes), countStyle: .file))）。"
        case .invalidTextEncoding:
            "文件不是有效的 UTF-8 文本，无法安全预览。"
        case .binaryFile:
            "检测到二进制内容，无法作为文本预览。"
        case .changedWhileReading:
            "读取期间文件发生变化，请重试。"
        case .cannotOpen:
            "无法打开该文件。"
        case .cannotRead:
            "无法完整读取该文件。"
        }
    }

    static func from(_ error: WorkspaceFileSecurePathError) -> WorkspaceFileReaderError {
        switch error {
        case .outsideSourceFolder: .outsideSourceFolder
        case .symbolicLink: .symbolicLink
        case .notRegularFile: .notRegularFile
        case .cannotOpen: .cannotOpen
        }
    }
}

enum WorkspaceFileReader {
    static let maximumBytes = 2 * 1_024 * 1_024

    static func read(
        path: String,
        sourceFolderPath: String,
        now: @escaping @Sendable () -> Date = Date.init
    ) async throws -> WorkspaceFileSnapshot {
        try await Task.detached(priority: .userInitiated) {
            let root = standardizedAbsolutePath(sourceFolderPath)
            let candidate = standardizedAbsolutePath(path)
            guard let relativeComponents = relativeComponents(of: candidate, inside: root) else {
                throw WorkspaceFileReaderError.outsideSourceFolder
            }

            let fileDescriptor = try securelyOpenFile(
                rootPath: root,
                relativeComponents: relativeComponents
            )
            defer { Darwin.close(fileDescriptor) }

            var before = stat()
            guard Darwin.fstat(fileDescriptor, &before) == 0 else {
                throw WorkspaceFileReaderError.cannotRead
            }
            guard before.st_mode & S_IFMT == S_IFREG else {
                throw WorkspaceFileReaderError.notRegularFile
            }
            guard before.st_size >= 0 else { throw WorkspaceFileReaderError.cannotRead }
            guard before.st_size <= off_t(maximumBytes) else {
                throw WorkspaceFileReaderError.fileTooLarge(maximumBytes: maximumBytes)
            }

            var data = Data()
            data.reserveCapacity(Int(before.st_size))
            var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
            while true {
                let count = Darwin.read(fileDescriptor, &buffer, buffer.count)
                if count == 0 { break }
                if count < 0 {
                    if errno == EINTR { continue }
                    throw WorkspaceFileReaderError.cannotRead
                }
                guard data.count + count <= maximumBytes else {
                    throw WorkspaceFileReaderError.fileTooLarge(maximumBytes: maximumBytes)
                }
                data.append(buffer, count: count)
            }

            var after = stat()
            guard Darwin.fstat(fileDescriptor, &after) == 0 else {
                throw WorkspaceFileReaderError.cannotRead
            }
            guard stable(before, after) else {
                throw WorkspaceFileReaderError.changedWhileReading
            }
            guard !looksBinary(data) else { throw WorkspaceFileReaderError.binaryFile }
            guard let text = String(data: data, encoding: .utf8) else {
                throw WorkspaceFileReaderError.invalidTextEncoding
            }

            return WorkspaceFileSnapshot(
                path: candidate,
                sourceFolderPath: root,
                relativePath: relativeComponents.joined(separator: "/"),
                text: text,
                byteCount: data.count,
                contentDigest: WorkspaceFileDigest.sha256Hex(of: data),
                loadedAt: now()
            )
        }.value
    }

    static func standardizedAbsolutePath(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }

    /// 预览资源读取（ADR 0026 决定 4）：与文本读取同一安全路径，但返回原始
    /// 字节（CSS / 图片 / 字体等），不做二进制与 UTF-8 检测；上限由调用方给定。
    static func readRawBytes(
        path: String,
        sourceFolderPath: String,
        maximumBytes: Int
    ) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let root = standardizedAbsolutePath(sourceFolderPath)
            let candidate = standardizedAbsolutePath(path)
            guard let relativeComponents = relativeComponents(of: candidate, inside: root) else {
                throw WorkspaceFileReaderError.outsideSourceFolder
            }
            let fileDescriptor = try securelyOpenFile(
                rootPath: root,
                relativeComponents: relativeComponents
            )
            defer { Darwin.close(fileDescriptor) }
            var metadata = stat()
            guard Darwin.fstat(fileDescriptor, &metadata) == 0 else {
                throw WorkspaceFileReaderError.cannotRead
            }
            guard metadata.st_mode & S_IFMT == S_IFREG else {
                throw WorkspaceFileReaderError.notRegularFile
            }
            guard metadata.st_size >= 0, metadata.st_size <= off_t(maximumBytes) else {
                throw WorkspaceFileReaderError.fileTooLarge(maximumBytes: maximumBytes)
            }
            var data = Data()
            data.reserveCapacity(Int(metadata.st_size))
            var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
            while true {
                let count = Darwin.read(fileDescriptor, &buffer, buffer.count)
                if count == 0 { break }
                if count < 0 {
                    if errno == EINTR { continue }
                    throw WorkspaceFileReaderError.cannotRead
                }
                guard data.count + count <= maximumBytes else {
                    throw WorkspaceFileReaderError.fileTooLarge(maximumBytes: maximumBytes)
                }
                data.append(buffer, count: count)
            }
            return data
        }.value
    }

    static func relativeComponents(of candidatePath: String, inside rootPath: String) -> [String]? {
        let rootComponents = URL(fileURLWithPath: rootPath).standardizedFileURL.pathComponents
        let candidateComponents = URL(fileURLWithPath: candidatePath).standardizedFileURL.pathComponents
        guard candidateComponents.count >= rootComponents.count,
              Array(candidateComponents.prefix(rootComponents.count)) == rootComponents else {
            return nil
        }
        return Array(candidateComponents.dropFirst(rootComponents.count))
    }

    /// 两次 fstat 是否指向同一文件（未被替换）。
    static func areStableInodes(_ before: stat, _ after: stat) -> Bool {
        before.st_dev == after.st_dev
            && before.st_ino == after.st_ino
            && before.st_size == after.st_size
    }

    private static func securelyOpenFile(
        rootPath: String,
        relativeComponents: [String]
    ) throws -> Int32 {
        guard let filename = relativeComponents.last else {
            throw WorkspaceFileReaderError.notRegularFile
        }
        do {
            let directoryDescriptor = try WorkspaceFileSecurePath.openParentDirectory(
                rootPath: rootPath,
                relativeComponents: Array(relativeComponents.dropLast())
            )
            do {
                guard let fileDescriptor = try WorkspaceFileSecurePath.openExistingFile(
                    directoryDescriptor: directoryDescriptor,
                    filename: filename
                ) else {
                    throw WorkspaceFileSecurePathError.cannotOpen
                }
                Darwin.close(directoryDescriptor)
                return fileDescriptor
            } catch {
                Darwin.close(directoryDescriptor)
                throw error
            }
        } catch let error as WorkspaceFileSecurePathError {
            throw WorkspaceFileReaderError.from(error)
        }
    }

    private static func stable(_ before: stat, _ after: stat) -> Bool {
        before.st_dev == after.st_dev
            && before.st_ino == after.st_ino
            && before.st_size == after.st_size
            && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec
            && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec
            && before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec
            && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
    }

    private static func looksBinary(_ data: Data) -> Bool {
        if data.contains(0) { return true }
        guard !data.isEmpty else { return false }
        let disallowed = data.reduce(into: 0) { count, byte in
            if byte < 0x20, byte != 0x09, byte != 0x0A, byte != 0x0D { count += 1 }
        }
        return disallowed > max(8, data.count / 100)
    }
}

enum WorkspaceFileLink {
    static let scheme = "dcode-workspace-file"

    struct Target: Equatable, Sendable {
        let path: String
        let line: Int?
    }

    static func presentationURL(for original: URL) -> URL? {
        let originalScheme = original.scheme?.lowercased()
        if originalScheme == scheme { return original }
        if originalScheme == "http" || originalScheme == "https" { return original }
        if ["javascript", "data", "vbscript", "about", "mailto"].contains(originalScheme) {
            return nil
        }

        let rawTarget: String
        if originalScheme == "file" {
            rawTarget = original.fragment.map { "\(original.path)#\($0)" } ?? original.path
        } else if originalScheme == nil {
            rawTarget = original.relativeString
        } else {
            return nil
        }
        let parsed = splitLineReference(rawTarget)
        guard !parsed.path.isEmpty else { return nil }
        return makeURL(path: parsed.path, line: parsed.line)
    }

    static func decode(_ url: URL) -> Target? {
        guard url.scheme?.lowercased() == scheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = components.queryItems?.first(where: { $0.name == "target" })?.value,
              !path.isEmpty else { return nil }
        let line = components.queryItems?
            .first(where: { $0.name == "line" })?
            .value
            .flatMap(Int.init)
            .flatMap { $0 > 0 ? $0 : nil }
        return Target(path: path, line: line)
    }

    private static func makeURL(path: String, line: Int?) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "open"
        var items = [URLQueryItem(name: "target", value: path)]
        if let line { items.append(URLQueryItem(name: "line", value: String(line))) }
        components.queryItems = items
        return components.url
    }

    private static func splitLineReference(_ raw: String) -> Target {
        let decoded = raw.removingPercentEncoding ?? raw
        if let hash = decoded.lastIndex(of: "#") {
            let fragment = decoded[decoded.index(after: hash)...]
            let digits = fragment.first == "L" ? fragment.dropFirst() : fragment[...]
            if let line = Int(digits), line > 0 {
                return Target(path: String(decoded[..<hash]), line: line)
            }
        }
        if let match = trailingLine(in: decoded) {
            return Target(path: match.path, line: match.line)
        }
        return Target(path: decoded, line: nil)
    }

    private static func trailingLine(in raw: String) -> Target? {
        guard let colon = raw.lastIndex(of: ":") else { return nil }
        let suffix = raw[raw.index(after: colon)...]
        guard let line = Int(suffix), line > 0 else { return nil }
        return Target(path: String(raw[..<colon]), line: line)
    }
}
