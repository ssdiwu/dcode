import Foundation
import Darwin
@main
struct FileRaceTest {
    static func main() async throws {
        let root = "/private/tmp/dcode-file-race-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: root) }
        let path = root + "/note.md", replacement = root + "/external.md"
        try Data("original".utf8).write(to: URL(fileURLWithPath: path))
        let original = try await WorkspaceFileReader.read(path: path, sourceFolderPath: root)
        do {
            _ = try await WorkspaceFileWriter.save(path: path, sourceFolderPath: root, text: "must not replace external change", expectedBaseDigest: original.contentDigest, beforeReplace: {
                try Data("external editor saved".utf8).write(to: URL(fileURLWithPath: replacement))
                guard Darwin.rename(replacement, path) == 0 else { throw NSError(domain: "fixture", code: 1) }
            })
            fatalError("Expected a conflict for an externally replaced file")
        } catch WorkspaceFileWriterError.conflict {}
        guard try String(contentsOfFile: path, encoding: .utf8) == "external editor saved" else { fatalError("External changes were overwritten") }
        print("Named-file replacement conflict preserved external content")
    }
}
