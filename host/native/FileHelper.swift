import Foundation
import Darwin

@main
struct FileHelper {
    struct Request: Decodable {
        let action: String
        let root: String
        let path: String
        let text: String?
        let expectedDigest: String?
        let overwrite: Bool?
        let arguments: [String]?
        let targetRoot: String?
        let sourceDevice: String?
        let sourceInode: String?
        let targetDevice: String?
        let targetInode: String?
        let requireEmptyTarget: Bool?
    }
    struct DirectorySwapError: LocalizedError { var errorDescription: String? { "原目录或空目标目录发生变化，项目文件没有被覆盖。" } }
    struct InvalidRequest: LocalizedError { var errorDescription: String? { "文件请求格式无效。" } }
    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    static func main() async {
        do {
            let bytes = FileHandle.standardInput.readDataToEndOfFile()
            guard bytes.count <= 12 * 1024 * 1024 else { throw InvalidRequest() }
            let request = try JSONDecoder().decode(Request.self, from: bytes)
            guard request.root.hasPrefix("/"), request.path.hasPrefix("/") else { throw InvalidRequest() }
            if request.action == "swap-directories", let targetRoot = request.targetRoot {
                let sourceParts = request.root.split(separator: "/").map(String.init)
                let targetParts = targetRoot.split(separator: "/").map(String.init)
                guard let sourceName = sourceParts.last, let targetName = targetParts.last, !sourceParts.contains(".."), !targetParts.contains(".."), request.root != targetRoot else { throw DirectorySwapError() }
                let sourceParent = try WorkspaceFileSecurePath.openParentDirectory(rootPath: "/", relativeComponents: Array(sourceParts.dropLast()))
                defer { Darwin.close(sourceParent) }
                let targetParent = try WorkspaceFileSecurePath.openParentDirectory(rootPath: "/", relativeComponents: Array(targetParts.dropLast()))
                defer { Darwin.close(targetParent) }
                var sourceStat = stat(), targetStat = stat()
                guard Darwin.fstatat(sourceParent, sourceName, &sourceStat, AT_SYMLINK_NOFOLLOW) == 0,
                      Darwin.fstatat(targetParent, targetName, &targetStat, AT_SYMLINK_NOFOLLOW) == 0,
                      sourceStat.st_mode & S_IFMT == S_IFDIR, targetStat.st_mode & S_IFMT == S_IFDIR,
                      String(sourceStat.st_dev) == request.sourceDevice, String(sourceStat.st_ino) == request.sourceInode,
                      String(targetStat.st_dev) == request.targetDevice, String(targetStat.st_ino) == request.targetInode,
                      sourceStat.st_dev == targetStat.st_dev else { throw DirectorySwapError() }
                if request.requireEmptyTarget != false {
                    let fd = Darwin.openat(targetParent, targetName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard fd >= 0 else { throw DirectorySwapError() }
                    guard let directory = Darwin.fdopendir(fd) else { Darwin.close(fd); throw DirectorySwapError() }
                    defer { Darwin.closedir(directory) }
                    while let entry = Darwin.readdir(directory) {
                        let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }
                        if name != "." && name != ".." { throw DirectorySwapError() }
                    }
                }
                guard renameatx_np(sourceParent, sourceName, targetParent, targetName, UInt32(RENAME_SWAP)) == 0 else { throw DirectorySwapError() }
                _ = Darwin.fsync(sourceParent); _ = Darwin.fsync(targetParent)
                emit(["ok": true]); return
            }
            if request.action == "git", let arguments = request.arguments {
                let top = ["rev-parse", "--show-toplevel"]
                let diffPrefix = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3"]
                let diffTail = Array(arguments.dropFirst(diffPrefix.count))
                let validDiff = arguments.starts(with: diffPrefix) && ((diffTail.count == 2 && diffTail[0] == "--") || (diffTail.count == 3 && diffTail[0] == "--cached" && diffTail[1] == "--"))
                guard arguments == top || arguments == ["rev-parse", "--abbrev-ref", "HEAD"] || arguments == ["status", "--porcelain=v1", "-z", "--untracked-files=normal"] || validDiff else { throw InvalidRequest() }
                let fd = try WorkspaceFileSecurePath.openParentDirectory(rootPath: request.root, relativeComponents: [])
                defer { Darwin.close(fd) }
                guard Darwin.fchdir(fd) == 0 else { throw InvalidRequest() }
                let process = Process(), output = Pipe()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                process.arguments = ["--no-optional-locks", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] + arguments
                process.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"]
                process.standardOutput = output; process.standardError = FileHandle.nullDevice
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + 10) { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 12) { if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) } }
                var bytes = Data()
                while let chunk = try output.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
                    bytes.append(chunk)
                    if bytes.count > 4 * 1024 * 1024 { process.terminate(); try? output.fileHandleForReading.close(); process.waitUntilExit(); throw InvalidRequest() }
                }
                process.waitUntilExit()
                guard process.terminationStatus == 0, let text = String(data: bytes, encoding: .utf8) else { emit(["ok": false, "code": arguments == top ? "GIT_NOT_REPOSITORY" : "GIT_UNAVAILABLE", "message": "Git 未能完成当前读取，文件没有被修改。"]); return }
                emit(["ok": true, "stdout": text]); return
            }
            if request.action == "tree" {
                let root = WorkspaceFileReader.standardizedAbsolutePath(request.root)
                let path = WorkspaceFileReader.standardizedAbsolutePath(request.path)
                let components: [String]
                if root == path { components = [] }
                else if let relative = WorkspaceFileReader.relativeComponents(of: path, inside: root) { components = relative }
                else { throw WorkspaceFileSecurePathError.outsideSourceFolder }
                let fd = try WorkspaceFileSecurePath.openParentDirectory(rootPath: root, relativeComponents: components)
                guard let directory = Darwin.fdopendir(fd) else { Darwin.close(fd); throw InvalidRequest() }
                defer { Darwin.closedir(directory) }
                var entries: [[String: String]] = []
                var truncated = false
                while let entry = Darwin.readdir(directory) {
                    let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                        pointer.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) }
                    }
                    if name == "." || name == ".." || name == ".git" || name == "node_modules" { continue }
                    var metadata = stat()
                    guard Darwin.fstatat(fd, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
                    let kind = metadata.st_mode & S_IFMT == S_IFDIR ? "directory" : metadata.st_mode & S_IFMT == S_IFREG ? "file" : metadata.st_mode & S_IFMT == S_IFLNK ? "link" : "other"
                    if entries.count >= 1000 { truncated = true; break }
                    entries.append(["name": name, "kind": kind])
                }
                emit(["ok": true, "entries": entries, "truncated": truncated]); return
            }
            if request.action == "asset" {
                let data = try await WorkspaceFileReader.readRawBytes(path: request.path, sourceFolderPath: request.root, maximumBytes: 8 * 1024 * 1024)
                emit(["ok": true, "base64": data.base64EncodedString()]); return
            }
            let snapshot: WorkspaceFileSnapshot
            if request.action == "read" {
                snapshot = try await WorkspaceFileReader.read(path: request.path, sourceFolderPath: request.root)
            } else if request.action == "save", let text = request.text {
                guard request.overwrite == true || request.expectedDigest != nil else { throw InvalidRequest() }
                snapshot = try await WorkspaceFileWriter.save(path: request.path, sourceFolderPath: request.root, text: text, expectedBaseDigest: request.overwrite == true ? nil : request.expectedDigest)
            } else { throw InvalidRequest() }
            emit(["ok": true, "text": snapshot.text, "digest": snapshot.contentDigest, "bytes": snapshot.byteCount, "relativePath": snapshot.relativePath])
        } catch {
            let code: String
            if let failure = error as? WorkspaceFileWriterError, failure == .conflict { code = "FILE_CONFLICT" }
            else if let failure = error as? WorkspaceFileReaderError, failure == .changedWhileReading { code = "FILE_CONFLICT" }
            else { code = "FILE_UNAVAILABLE" }
            emit(["ok": false, "code": code, "message": (error as? WorkspaceFileSecurePathError).map { WorkspaceFileReaderError.from($0).localizedDescription } ?? error.localizedDescription])
        }
    }
}
