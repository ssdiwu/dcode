import Foundation

public struct RelaunchHelperRequest: Equatable, Sendable {
    public static let defaultTimeoutSeconds: TimeInterval = 30
    public static let maximumTimeoutSeconds: TimeInterval = 120

    public let oldPID: Int32
    public let appURL: URL
    public let distDirectoryURL: URL
    public let timeoutSeconds: TimeInterval

    public init(
        oldPID: Int32,
        appURL: URL,
        distDirectoryURL: URL,
        timeoutSeconds: TimeInterval = RelaunchHelperRequest.defaultTimeoutSeconds
    ) {
        self.oldPID = oldPID
        self.appURL = appURL
        self.distDirectoryURL = distDirectoryURL
        self.timeoutSeconds = timeoutSeconds
    }

    public var commandArguments: [String] {
        [
            "--pid", String(oldPID),
            "--app-path", appURL.path,
            "--dist-path", distDirectoryURL.path,
            "--timeout", String(timeoutSeconds),
        ]
    }
}

public enum RelaunchHelperPathPolicy {
    public static let activeBundleName = "D Code.app"
    public static let distDirectoryName = "dist"

    public static func canonicalAppURL(
        appURL: URL,
        distDirectoryURL: URL,
        fileManager: FileManager = .default
    ) -> URL? {
        let canonicalDist = distDirectoryURL.standardizedFileURL.resolvingSymlinksInPath()
        let canonicalApp = appURL.standardizedFileURL.resolvingSymlinksInPath()
        guard canonicalDist.lastPathComponent == distDirectoryName,
              canonicalApp.lastPathComponent == activeBundleName,
              canonicalApp.deletingLastPathComponent() == canonicalDist else {
            return nil
        }

        var isDirectory = ObjCBool(false)
        guard fileManager.fileExists(atPath: canonicalDist.path, isDirectory: &isDirectory),
              isDirectory.boolValue,
              fileManager.fileExists(atPath: canonicalApp.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return nil
        }
        return canonicalApp
    }
}

public enum RelaunchHelperOutcome: Equatable, Sendable {
    case launched
    case timedOut
    case launchFailed
    case invalidRequest(String)
}

public enum RelaunchHelperArgumentError: LocalizedError, Equatable, Sendable {
    case missingValue(String)
    case duplicate(String)
    case invalidValue(String)
    case unknownOption(String)

    public var errorDescription: String? {
        switch self {
        case let .missingValue(option): "缺少参数值：\(option)"
        case let .duplicate(option): "重复参数：\(option)"
        case let .invalidValue(option): "参数无效：\(option)"
        case let .unknownOption(option): "未知参数：\(option)"
        }
    }
}

public enum RelaunchHelperArgumentParser {
    public static func parse(_ arguments: [String]) throws -> RelaunchHelperRequest {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let option = arguments[index]
            guard option == "--pid"
                    || option == "--app-path"
                    || option == "--dist-path"
                    || option == "--timeout" else {
                throw RelaunchHelperArgumentError.unknownOption(option)
            }
            guard index + 1 < arguments.count else {
                throw RelaunchHelperArgumentError.missingValue(option)
            }
            guard values[option] == nil else {
                throw RelaunchHelperArgumentError.duplicate(option)
            }
            values[option] = arguments[index + 1]
            index += 2
        }

        guard let pidValue = values["--pid"], let pid = Int32(pidValue), pid > 0 else {
            throw RelaunchHelperArgumentError.invalidValue("--pid")
        }
        guard let appPath = values["--app-path"], !appPath.isEmpty else {
            throw RelaunchHelperArgumentError.invalidValue("--app-path")
        }
        guard let distPath = values["--dist-path"], !distPath.isEmpty else {
            throw RelaunchHelperArgumentError.invalidValue("--dist-path")
        }
        guard let timeoutValue = values["--timeout"],
              let timeout = TimeInterval(timeoutValue),
              timeout.isFinite,
              timeout > 0 else {
            throw RelaunchHelperArgumentError.invalidValue("--timeout")
        }
        return RelaunchHelperRequest(
            oldPID: pid,
            appURL: URL(fileURLWithPath: appPath, isDirectory: true),
            distDirectoryURL: URL(fileURLWithPath: distPath, isDirectory: true),
            timeoutSeconds: timeout
        )
    }
}

public enum RelaunchHelperRunner {
    public static let oldProcessSettlingDelay: Duration = .seconds(3)

    public static func run(
        request: RelaunchHelperRequest,
        isProcessAlive: @escaping @Sendable (Int32) -> Bool,
        sleep: @escaping @Sendable (Duration) async -> Void,
        launch: @escaping @Sendable (URL) async -> Bool,
        now: @escaping @Sendable () -> TimeInterval = {
            Date().timeIntervalSinceReferenceDate
        }
    ) async -> RelaunchHelperOutcome {
        guard request.oldPID > 0 else {
            return .invalidRequest("旧 App PID 无效")
        }
        guard request.timeoutSeconds.isFinite,
              request.timeoutSeconds > 0,
              request.timeoutSeconds <= RelaunchHelperRequest.maximumTimeoutSeconds else {
            return .invalidRequest("等待超时必须在 0 到 \(RelaunchHelperRequest.maximumTimeoutSeconds) 秒内")
        }
        guard let appURL = RelaunchHelperPathPolicy.canonicalAppURL(
            appURL: request.appURL,
            distDirectoryURL: request.distDirectoryURL
        ) else {
            return .invalidRequest("目标 App 必须是当前 Self-build 的 dist/D Code.app")
        }

        let deadline = now() + request.timeoutSeconds
        while isProcessAlive(request.oldPID) {
            let remaining = deadline - now()
            guard remaining > 0 else { return .timedOut }
            let milliseconds = max(1, min(100, Int((remaining * 1_000).rounded(.down))))
            await sleep(.milliseconds(milliseconds))
        }

        // PID 消失后给文件描述符、会话与应用生命周期清理一个固定有界窗口，
        // 然后只启动一次目标 bundle 的真实 executable。
        await sleep(oldProcessSettlingDelay)
        return await launch(appURL) ? .launched : .launchFailed
    }
}
