import Darwin
import AppKit
import Foundation
import RelaunchCore

@main
struct DCodeRelaunchHelperMain {
    static func main() async {
        do {
            let request = try RelaunchHelperArgumentParser.parse(Array(CommandLine.arguments.dropFirst()))
            let outcome = await RelaunchHelperRunner.run(
                request: request,
                isProcessAlive: { pid in
                    kill(pid, 0) == 0 || errno == EPERM
                },
                sleep: { duration in
                    try? await Task.sleep(for: duration)
                },
                launch: { appURL in
                    await launchApplication(at: appURL, excludingPID: request.oldPID)
                }
            )
            switch outcome {
            case .launched:
                // LaunchServices 的请求方过早退出会让刚出现的新 App 随即终止。
                // 新 PID 已稳定后再保留一个短、有界的交接窗口，不重试、不监控业务。
                try? await Task.sleep(for: .seconds(5))
                exit(EXIT_SUCCESS)
            case .timedOut:
                writeError("等待旧 D Code 进程退出超时；restart marker 与备份已保留。")
                exit(2)
            case .launchFailed:
                writeError("无法打开新的 D Code；restart marker 与备份已保留。")
                exit(3)
            case let .invalidRequest(message):
                writeError(message)
                exit(64)
            }
        } catch {
            writeError(error.localizedDescription)
            exit(64)
        }
    }

    private static func launchApplication(at appURL: URL, excludingPID oldPID: Int32) async -> Bool {
        let open = Process()
        open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        open.arguments = ["-W", appURL.path]
        var environment = ProcessInfo.processInfo.environment
        for inheritedIdentityKey in ["__CFBundleIdentifier"] {
            environment.removeValue(forKey: inheritedIdentityKey)
        }
        open.environment = environment
        open.standardOutput = FileHandle.nullDevice
        open.standardError = FileHandle.nullDevice
        do {
            try open.run()
        } catch {
            return false
        }

        let target = appURL.standardizedFileURL.resolvingSymlinksInPath()
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            guard let application = matchingRunningApplication(
                target: target,
                excludingPID: oldPID
            ) else {
                try? await Task.sleep(for: .milliseconds(100))
                continue
            }
            let launchedPID = application.processIdentifier
            try? await Task.sleep(for: .seconds(1))
            return matchingRunningApplication(
                target: target,
                excludingPID: oldPID
            )?.processIdentifier == launchedPID
        }
        return false
    }

    private static func matchingRunningApplication(
        target: URL,
        excludingPID oldPID: Int32
    ) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { application in
            guard application.processIdentifier != oldPID,
                  !application.isTerminated,
                  let bundleURL = application.bundleURL else { return false }
            return bundleURL.standardizedFileURL.resolvingSymlinksInPath() == target
        }
    }

    private static func writeError(_ message: String) {
        let data = Data("DCodeRelaunchHelper: \(message)\n".utf8)
        try? FileHandle.standardError.write(contentsOf: data)
    }
}
