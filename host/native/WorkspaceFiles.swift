// Shared macOS file boundary migrated from the existing Swift client (ADR 0025/0026).
import Foundation
import CryptoKit
import Darwin

// Foundation standardization maps /private/var back to the /var symlink.
// The descriptor boundary needs lexical normalization, preserving physical roots.
func workspaceFilePath(_ path: String) -> String {
    var parts: [Substring] = []
    for part in path.split(separator: "/") {
        if part == "." { continue }
        if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
        parts.append(part)
    }
    return "/" + parts.joined(separator: "/")
}

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
            let rootComponents = URL(fileURLWithPath: workspaceFilePath(rootPath)).pathComponents
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
            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
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
            "该文件不在当前登记的项目目录内，已停止读取。"
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
        workspaceFilePath(path)
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
            var after = stat()
            guard Darwin.fstat(fileDescriptor, &after) == 0,
                  areStableInodes(metadata, after), data.count == Int(metadata.st_size) else {
                throw WorkspaceFileReaderError.changedWhileReading
            }
            return data
        }.value
    }

    static func relativeComponents(of candidatePath: String, inside rootPath: String) -> [String]? {
        let rootComponents = URL(fileURLWithPath: workspaceFilePath(rootPath)).pathComponents
        let candidateComponents = URL(fileURLWithPath: workspaceFilePath(candidatePath)).pathComponents
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



/// Markdown 编辑的安全保存（ADR 0025 决定 1、4、5）：与读取共享同一套
/// 安全路径遍历；保存 = 同目录临时文件 → fsync → 原子替换 → 目录 fsync；
/// 写入前校验磁盘内容指纹与基准一致，不匹配即冲突拒绝，绝不盲目覆盖。
enum WorkspaceFileWriterError: LocalizedError, Equatable {
    case outsideSourceFolder
    case symbolicLink
    case notRegularFile
    case fileMissing
    case conflict
    case fileTooLarge(maximumBytes: Int)
    case cannotOpen
    case cannotWrite
    case cannotReplace

    var errorDescription: String? {
        switch self {
        case .outsideSourceFolder:
            "该文件不在当前登记的项目目录内，已停止保存。"
        case .symbolicLink:
            "该路径包含符号链接。为避免越过项目边界，D Code 不会写入。"
        case .notRegularFile:
            "该位置不是可保存的普通文件。"
        case .fileMissing:
            "文件已不存在。D Code 不创建新文件；请重新加载或在外部确认。"
        case .conflict:
            "磁盘上的文件在编辑期间被外部修改，本次保存已取消。可重新加载、显式覆盖或继续编辑。"
        case let .fileTooLarge(maximumBytes):
            "内容超过保存上限（\(ByteCountFormatter.string(fromByteCount: Int64(maximumBytes), countStyle: .file))）。"
        case .cannotOpen:
            "无法打开该文件。"
        case .cannotWrite:
            "无法写入临时文件，原文件未改动。"
        case .cannotReplace:
            "无法原子替换目标文件，原文件未改动。"
        }
    }

    static func from(_ error: WorkspaceFileSecurePathError) -> WorkspaceFileWriterError {
        switch error {
        case .outsideSourceFolder: .outsideSourceFolder
        case .symbolicLink: .symbolicLink
        case .notRegularFile: .notRegularFile
        case .cannotOpen: .cannotOpen
        }
    }
}

enum WorkspaceFileWriter {
    static let maximumBytes = WorkspaceFileReader.maximumBytes

    /// 保存缓冲区文本并返回新快照。
    /// - Parameter expectedBaseDigest: 上次加载 / 保存成功时的磁盘内容 SHA-256；
    ///   传入 nil 表示用户在冲突态显式选择覆盖（ADR 0025 决定 5 的三选之一），
    ///   跳过指纹比对，但文件必须仍存在且为普通文件——D Code 不创建新文件。
    static func save(
        path: String,
        sourceFolderPath: String,
        text: String,
        expectedBaseDigest: String?,
        now: @escaping @Sendable () -> Date = Date.init,
        beforeReplace: (@Sendable () throws -> Void)? = nil
    ) async throws -> WorkspaceFileSnapshot {
        let payload = Data(text.utf8)
        return try await Task.detached(priority: .userInitiated) {
            let root = WorkspaceFileReader.standardizedAbsolutePath(sourceFolderPath)
            let candidate = WorkspaceFileReader.standardizedAbsolutePath(path)
            guard let relativeComponents = WorkspaceFileReader.relativeComponents(of: candidate, inside: root) else {
                throw WorkspaceFileWriterError.outsideSourceFolder
            }
            guard let filename = relativeComponents.last, !filename.isEmpty else {
                throw WorkspaceFileWriterError.notRegularFile
            }
            guard payload.count <= maximumBytes else {
                throw WorkspaceFileWriterError.fileTooLarge(maximumBytes: maximumBytes)
            }

            let directoryDescriptor: Int32
            do {
                directoryDescriptor = try WorkspaceFileSecurePath.openParentDirectory(
                    rootPath: root,
                    relativeComponents: Array(relativeComponents.dropLast())
                )
            } catch let error as WorkspaceFileSecurePathError {
                throw WorkspaceFileWriterError.from(error)
            }
            defer { Darwin.close(directoryDescriptor) }

            // 现状校验：文件必须仍是既有普通文件，且内容指纹与基准一致。
            let fileDescriptor: Int32
            do {
                guard let opened = try WorkspaceFileSecurePath.openExistingFile(
                    directoryDescriptor: directoryDescriptor,
                    filename: filename
                ) else {
                    throw WorkspaceFileWriterError.fileMissing
                }
                fileDescriptor = opened
            } catch let error as WorkspaceFileSecurePathError {
                throw WorkspaceFileWriterError.from(error)
            }
            defer { Darwin.close(fileDescriptor) }
            // Serialize cooperating D Code writers, including separate helper processes.
            guard flock(fileDescriptor, LOCK_EX | LOCK_NB) == 0 else {
                throw WorkspaceFileWriterError.conflict
            }

            var metadata = stat()
            guard Darwin.fstat(fileDescriptor, &metadata) == 0 else {
                throw WorkspaceFileWriterError.cannotOpen
            }
            guard metadata.st_mode & S_IFMT == S_IFREG else {
                throw WorkspaceFileWriterError.notRegularFile
            }
            if let expectedBaseDigest {
                let currentDigest = try digestOfRegularFile(
                    fileDescriptor: fileDescriptor,
                    metadata: metadata
                )
                guard currentDigest == expectedBaseDigest else {
                    throw WorkspaceFileWriterError.conflict
                }
                // 指纹校验通过后仍以 fstat 为准再次确认未被并发替换。
                var recheck = stat()
                guard Darwin.fstat(fileDescriptor, &recheck) == 0,
                      WorkspaceFileReader.areStableInodes(metadata, recheck) else {
                    throw WorkspaceFileWriterError.conflict
                }
            }

            // 同目录临时文件 + renameat：读者要么看到旧全文，要么看到新全文。
            let temporaryName = ".\(filename).dcode-\(UUID().uuidString).tmp"
            let temporaryDescriptor = Darwin.openat(
                directoryDescriptor,
                temporaryName,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
                0o600
            )
            guard temporaryDescriptor >= 0 else {
                throw WorkspaceFileWriterError.cannotWrite
            }
            var temporaryActive = true
            defer {
                Darwin.close(temporaryDescriptor)
                if temporaryActive {
                    Darwin.unlinkat(directoryDescriptor, temporaryName, 0)
                }
            }

            try writeFully(payload, to: temporaryDescriptor)
            // 精确保留原文件权限位（openat 的 mode 会被 umask 过滤，fchmod 不受影响）。
            guard Darwin.fchmod(temporaryDescriptor, metadata.st_mode & 0o7777) == 0 else {
                throw WorkspaceFileWriterError.cannotWrite
            }
            guard Darwin.fsync(temporaryDescriptor) == 0 else {
                throw WorkspaceFileWriterError.cannotWrite
            }

            try beforeReplace?()
            // An open old fd survives another editor's atomic replacement. Reopen
            // the named directory and file before committing, and compare identity
            // as well as bytes rather than trusting the old descriptor alone.
            let currentDirectory: Int32
            do { currentDirectory = try WorkspaceFileSecurePath.openParentDirectory(rootPath: root, relativeComponents: Array(relativeComponents.dropLast())) }
            catch { throw WorkspaceFileWriterError.conflict }
            defer { Darwin.close(currentDirectory) }
            var originalDirectory = stat(), namedDirectory = stat()
            guard Darwin.fstat(directoryDescriptor, &originalDirectory) == 0,
                  Darwin.fstat(currentDirectory, &namedDirectory) == 0,
                  originalDirectory.st_dev == namedDirectory.st_dev,
                  originalDirectory.st_ino == namedDirectory.st_ino else { throw WorkspaceFileWriterError.conflict }
            let namedFile: Int32
            do {
                guard let opened = try WorkspaceFileSecurePath.openExistingFile(directoryDescriptor: currentDirectory, filename: filename) else { throw WorkspaceFileWriterError.conflict }
                namedFile = opened
            } catch { throw WorkspaceFileWriterError.conflict }
            defer { Darwin.close(namedFile) }
            var namedMetadata = stat()
            guard Darwin.fstat(namedFile, &namedMetadata) == 0,
                  WorkspaceFileReader.areStableInodes(metadata, namedMetadata) else { throw WorkspaceFileWriterError.conflict }
            if let expectedBaseDigest {
                guard try digestOfRegularFile(fileDescriptor: namedFile, metadata: namedMetadata) == expectedBaseDigest else { throw WorkspaceFileWriterError.conflict }
            }

            guard Darwin.renameat(directoryDescriptor, temporaryName, directoryDescriptor, filename) == 0 else {
                throw WorkspaceFileWriterError.cannotReplace
            }
            temporaryActive = false
            // rename 已生效；目录 fsync 尽力而为，失败不回滚（下次 fsync 补账）。
            _ = Darwin.fsync(directoryDescriptor)

            return WorkspaceFileSnapshot(
                path: candidate,
                sourceFolderPath: root,
                relativePath: relativeComponents.joined(separator: "/"),
                text: text,
                byteCount: payload.count,
                contentDigest: WorkspaceFileDigest.sha256Hex(of: payload),
                loadedAt: now()
            )
        }.value
    }

    private static func digestOfRegularFile(
        fileDescriptor: Int32,
        metadata: stat
    ) throws -> String {
        guard metadata.st_size >= 0, metadata.st_size <= off_t(maximumBytes) else {
            throw WorkspaceFileWriterError.conflict
        }
        var data = Data()
        data.reserveCapacity(Int(metadata.st_size))
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        while true {
            let count = Darwin.read(fileDescriptor, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw WorkspaceFileWriterError.cannotOpen
            }
            guard data.count + count <= maximumBytes else {
                throw WorkspaceFileWriterError.conflict
            }
            data.append(buffer, count: count)
        }
        return WorkspaceFileDigest.sha256Hex(of: data)
    }

    private static func writeFully(_ data: Data, to fileDescriptor: Int32) throws {
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { raw in
                Darwin.write(
                    fileDescriptor,
                    raw.baseAddress!.advanced(by: offset),
                    raw.count - offset
                )
            }
            if written <= 0 {
                if written < 0, errno == EINTR { continue }
                throw WorkspaceFileWriterError.cannotWrite
            }
            offset += written
        }
    }
}
