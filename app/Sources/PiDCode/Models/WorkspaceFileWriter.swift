import Darwin
import Foundation

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
            "该文件不在当前登记的源文件夹内，已停止保存。"
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
        now: @escaping @Sendable () -> Date = Date.init
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
