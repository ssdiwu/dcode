import Foundation
import ImageIO
import Darwin

@main
enum GeneratedImageHelper {
    static func inspect(_ bytes: Data) throws -> [String: Any] {
        guard !bytes.isEmpty, bytes.count <= 5_000_000,
              let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetCount(source) == 1,
              let type = CGImageSourceGetType(source) as String?,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
              let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
              width > 0, height > 0, width <= 10_000, height <= 10_000, width * height <= 40_000_000 else { throw CocoaError(.fileReadCorruptFile) }
        let formats = ["public.png": ("image/png", "png"), "public.jpeg": ("image/jpeg", "jpg"), "org.webmproject.webp": ("image/webp", "webp")]
        guard let format = formats[type], CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) != nil else { throw CocoaError(.fileReadCorruptFile) }
        return ["mimeType": format.0, "extension": format.1, "width": width, "height": height, "bytes": bytes.count]
    }

    static func publish(_ bytes: Data, root: String, name: String, expectedDevice: String, expectedInode: String) throws {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"), !name.contains("\0"), name.utf8.count <= 240 else { throw CocoaError(.fileWriteInvalidFileName) }
        let directory = try WorkspaceFileSecurePath.openParentDirectory(rootPath: root, relativeComponents: [])
        defer { Darwin.close(directory) }
        var identity = stat()
        guard fstat(directory, &identity) == 0, String(identity.st_dev) == expectedDevice, String(identity.st_ino) == expectedInode else { throw WorkspaceFileSecurePathError.changedIdentity }
        let staging = ".dcode-image-\(UUID().uuidString).pending"
        let fd = openat(directory, staging, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(fd); unlinkat(directory, staging, 0) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), bytes.count - offset)
                if written < 0 { if errno == EINTR { continue }; throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                if written == 0 { throw POSIXError(.EIO) }
                offset += written
            }
        }
        guard fsync(fd) == 0, linkat(directory, staging, directory, name, 0) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        _ = fsync(directory)
    }

    static func main() {
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count <= 7_000_000,
                  let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
                  let encoded = request["data"] as? String,
                  let bytes = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
            let info = try inspect(bytes)
            if request["action"] as? String == "export" {
                guard let root = request["directory"] as? String, let name = request["name"] as? String, let device=request["device"] as? String, let inode=request["inode"] as? String else { throw CocoaError(.fileWriteInvalidFileName) }
                try publish(bytes, root: root, name: name, expectedDevice: device, expectedInode: inode)
            }
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: info))
        } catch {
            let code = (error as? POSIXError)?.code == .EEXIST ? "IMAGE_EXPORT_EXISTS" : "IMAGE_INVALID_OR_UNWRITABLE"
            FileHandle.standardOutput.write(Data("{\"error\":\"\(code)\"}".utf8))
        }
    }
}
