import Foundation

struct HostLaunchConfiguration: Sendable, Equatable {
    let nodeURL: URL
    let hostEntryURL: URL
    let agentDirectoryURL: URL

    var arguments: [String] {
        [hostEntryURL.path, "--agent-dir", agentDirectoryURL.path]
    }
}

enum HostProcessEnvironment {
    static func make(
        base: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        agentDirectoryURL: URL
    ) -> [String: String] {
        var environment = base
        var seen = Set<String>()
        let inherited = (base["PATH"] ?? "")
            .split(separator: ":", omittingEmptySubsequences: true)
            .map(String.init)
        let fallbacks = [
            homeDirectory.appending(path: ".local/bin").path,
            homeDirectory.appending(path: ".hermes/node/bin").path,
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        environment["PATH"] = (inherited + fallbacks)
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
        environment["HOME"] = base["HOME"] ?? homeDirectory.path
        environment["NO_COLOR"] = "1"
        environment["PI_CODING_AGENT_DIR"] = agentDirectoryURL.path
        return environment
    }
}

enum HostLocatorError: LocalizedError, Sendable {
    case nodeMissing([String])
    case hostMissing([String])

    var errorDescription: String? {
        switch self {
        case let .nodeMissing(paths):
            "找不到可执行的 Node runtime。已检查：\n\(paths.joined(separator: "\n"))"
        case let .hostMissing(paths):
            "找不到已构建的 Pi Host。请先运行 `cd host && npm run build`。已检查：\n\(paths.joined(separator: "\n"))"
        }
    }
}

enum HostLocator {
    static func resolve(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) throws -> HostLaunchConfiguration {
        let resourceURL = bundle.resourceURL
        let projectRoot = sourceProjectRoot

        var nodeCandidates: [URL] = []
        if let override = option("--node-bin", in: arguments) ?? environment["PI_DCODE_NODE_BIN"] {
            nodeCandidates.append(expand(override, homeDirectory: homeDirectory))
        }
        if let resourceURL {
            nodeCandidates.append(resourceURL.appending(path: "runtime/node"))
            nodeCandidates.append(resourceURL.appending(path: "node/bin/node"))
        }
        nodeCandidates.append(homeDirectory.appending(path: ".hermes/node/bin/node"))
        nodeCandidates.append(URL(fileURLWithPath: "/opt/homebrew/bin/node"))
        nodeCandidates.append(URL(fileURLWithPath: "/usr/local/bin/node"))

        var hostCandidates: [URL] = []
        if let override = option("--host-entry", in: arguments) ?? environment["PI_DCODE_HOST_ENTRY"] {
            hostCandidates.append(expand(override, homeDirectory: homeDirectory))
        }
        if let resourceURL {
            hostCandidates.append(resourceURL.appending(path: "host/dist/src/index.js"))
        }
        hostCandidates.append(projectRoot.appending(path: "host/dist/src/index.js"))

        guard let nodeURL = nodeCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            throw HostLocatorError.nodeMissing(nodeCandidates.map(\.path))
        }
        guard let hostEntryURL = hostCandidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw HostLocatorError.hostMissing(hostCandidates.map(\.path))
        }

        let agentPath = option("--agent-dir", in: arguments)
            ?? environment["PI_DCODE_AGENT_DIR"]
            ?? homeDirectory.appending(path: ".pi/agent").path
        return HostLaunchConfiguration(
            nodeURL: nodeURL.standardizedFileURL,
            hostEntryURL: hostEntryURL.standardizedFileURL,
            agentDirectoryURL: expand(agentPath, homeDirectory: homeDirectory).standardizedFileURL
        )
    }

    private static var sourceProjectRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url
    }

    private static func option(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private static func expand(_ path: String, homeDirectory: URL) -> URL {
        if path == "~" { return homeDirectory }
        if path.hasPrefix("~/") {
            return homeDirectory.appending(path: String(path.dropFirst(2)))
        }
        return URL(fileURLWithPath: path)
    }
}
