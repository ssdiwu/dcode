import Foundation
import RelaunchCore
import XCTest
@testable import PiDCode

private final class RelaunchTestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var nowValue = 0.0
    private var launchCountValue = 0
    private var aliveCheckCount = 0
    private var launchedURLValues: [URL] = []
    private var sleepDurations: [Duration] = []

    func advance(_ seconds: Double) { lock.withLock { nowValue += seconds } }
    func now() -> TimeInterval { lock.withLock { nowValue } }
    func recordLaunch(_ url: URL? = nil) {
        lock.withLock {
            launchCountValue += 1
            if let url { launchedURLValues.append(url) }
        }
    }
    func launchCount() -> Int { lock.withLock { launchCountValue } }
    func launchedURLs() -> [URL] { lock.withLock { launchedURLValues } }
    func recordSleep(_ duration: Duration) { lock.withLock { sleepDurations.append(duration) } }
    func recordedSleeps() -> [Duration] { lock.withLock { sleepDurations } }
    func isAliveOnFirstCheck() -> Bool {
        lock.withLock {
            aliveCheckCount += 1
            return aliveCheckCount == 1
        }
    }
}
final class RelaunchHelperTests: XCTestCase {
    private func temporaryRoot(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-relaunch-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testHelperCanBeStagedBeforeItsRunningBundleMoves() throws {
        let root = try temporaryRoot("stage")
        let bundle = root.appending(path: "dist-candidate/D Code.app", directoryHint: .isDirectory)
        let resources = bundle.appending(path: "Contents/Resources", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let source = resources.appending(path: SelfBuildRelaunchLauncher.helperResourceName)
        let sourceExecutable = SelfBuildRelaunchLauncher.helperExecutableURL(helperAppURL: source)
        try FileManager.default.createDirectory(
            at: sourceExecutable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("helper".utf8).write(to: sourceExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: sourceExecutable.path)
        let dist = root.appending(path: "dist", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)

        let staged = try SelfBuildRelaunchLauncher.stageHelper(
            bundleURL: bundle,
            distDirectoryURL: dist
        )
        try FileManager.default.moveItem(at: bundle, to: root.appending(path: "moved.app"))

        let stagedExecutable = SelfBuildRelaunchLauncher.helperExecutableURL(helperAppURL: staged)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: stagedExecutable.path))
        XCTAssertEqual(try Data(contentsOf: stagedExecutable), Data("helper".utf8))
    }

    private func temporaryDist(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-relaunch-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        let dist = root.appending(path: "dist", directoryHint: .isDirectory)
        let app = dist.appending(path: "D Code.app", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return dist
    }

    private func request(dist: URL, timeout: TimeInterval = 1) -> RelaunchHelperRequest {
        RelaunchHelperRequest(
            oldPID: 1234,
            appURL: dist.appending(path: "D Code.app", directoryHint: .isDirectory),
            distDirectoryURL: dist,
            timeoutSeconds: timeout
        )
    }

    func testOldPIDStaysAlivePreventsLaunchAfterBoundedTimeout() async throws {
        let dist = try temporaryDist("alive")
        let box = RelaunchTestBox()
        let outcome = await RelaunchHelperRunner.run(
            request: request(dist: dist, timeout: 0.25),
            isProcessAlive: { _ in true },
            sleep: { duration in
                box.recordSleep(duration)
                box.advance(0.1)
            },
            launch: { _ in
                box.recordLaunch()
                return true
            },
            now: { box.now() }
        )

        XCTAssertEqual(outcome, .timedOut)
        XCTAssertEqual(box.launchCount(), 0, "旧 PID 存活时绝不能预先打开新 App")
    }

    func testOldPIDDisappearingLaunchesExactlyOnce() async throws {
        let dist = try temporaryDist("disappears")
        let box = RelaunchTestBox()
        let outcome = await RelaunchHelperRunner.run(
            request: request(dist: dist, timeout: 1),
            isProcessAlive: { _ in box.isAliveOnFirstCheck() },
            sleep: { duration in
                box.recordSleep(duration)
                box.advance(0.1)
            },
            launch: { url in
                box.recordLaunch(url)
                return true
            },
            now: { box.now() }
        )

        XCTAssertEqual(outcome, .launched)
        XCTAssertEqual(box.launchedURLs(), [dist.appending(path: "D Code.app", directoryHint: .isDirectory)])
        XCTAssertEqual(box.launchCount(), 1)
        XCTAssertEqual(
            box.recordedSleeps().last,
            RelaunchHelperRunner.oldProcessSettlingDelay,
            "旧 PID 消失后必须先等待应用生命周期清理，再做唯一一次启动"
        )
    }

    func testLaunchFailureIsReportedWithoutRetry() async throws {
        let dist = try temporaryDist("launch-failure")
        let box = RelaunchTestBox()
        let outcome = await RelaunchHelperRunner.run(
            request: request(dist: dist),
            isProcessAlive: { _ in false },
            sleep: { _ in },
            launch: { _ in
                box.recordLaunch()
                return false
            }
        )

        XCTAssertEqual(outcome, .launchFailed)
        XCTAssertEqual(box.launchCount(), 1)
    }

    func testOnlyCurrentSelfBuildDistAppPathIsAccepted() async throws {
        let dist = try temporaryDist("path-policy")
        let candidate = dist.deletingLastPathComponent()
            .appending(path: "dist-candidate", directoryHint: .isDirectory)
            .appending(path: "D Code.app", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        let box = RelaunchTestBox()
        let outcome = await RelaunchHelperRunner.run(
            request: RelaunchHelperRequest(
                oldPID: 1234,
                appURL: candidate,
                distDirectoryURL: dist,
                timeoutSeconds: 1
            ),
            isProcessAlive: { _ in false },
            sleep: { _ in },
            launch: { _ in
                box.recordLaunch()
                return true
            }
        )

        guard case .invalidRequest = outcome else {
            return XCTFail("dist-candidate 路径不得作为重启目标")
        }
        XCTAssertEqual(box.launchCount(), 0)
    }


    func testArgumentsKeepPIDAndPathsAsSeparateProcessArguments() throws {
        let dist = try temporaryDist("arguments")
        let arguments = request(dist: dist).commandArguments

        XCTAssertEqual(arguments[0...1], ["--pid", "1234"])
        XCTAssertEqual(arguments[2...3], ["--app-path", dist.appending(path: "D Code.app").path])
        XCTAssertEqual(arguments[4...5], ["--dist-path", dist.path])
        XCTAssertEqual(
            try RelaunchHelperArgumentParser.parse(arguments),
            request(dist: dist)
        )
    }

    func testHelperUsesLaunchServicesThenVerifiesAStableNewProcessAtTheAbsoluteBundlePath() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let appRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: appRoot.appending(path: "Sources/RelaunchHelper/main.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("open.executableURL = URL(fileURLWithPath: \"/usr/bin/open\")"))
        XCTAssertTrue(source.contains("open.arguments = [\"-W\", appURL.path]"))
        XCTAssertFalse(source.contains("\"-n\""), "禁止多实例 App 不得请求 -n")
        XCTAssertTrue(source.contains("open.environment = environment"))
        XCTAssertTrue(source.contains("environment.removeValue(forKey: inheritedIdentityKey)"))
        XCTAssertTrue(source.contains("NSWorkspace.shared.runningApplications.first"))
        XCTAssertTrue(source.contains("application.processIdentifier != oldPID"))
        XCTAssertTrue(source.contains("bundleURL.standardizedFileURL.resolvingSymlinksInPath() == target"))
        XCTAssertTrue(source.contains("?.processIdentifier == launchedPID"), "新进程必须连续稳定而非短暂出现")
        XCTAssertTrue(source.contains("Task.sleep(for: .seconds(5))"), "请求方必须保留有界交接窗口")

        let modelSource = try String(
            contentsOf: appRoot.appending(path: "Sources/PiDCode/Models/SelfBuildModels.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(modelSource.contains("NSWorkspace.shared.runningApplications.contains"))
        XCTAssertTrue(modelSource.contains("application.bundleIdentifier == helperBundleIdentifier"))
        XCTAssertTrue(modelSource.contains("application.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == target"))
        XCTAssertTrue(modelSource.contains("throw SelfBuildRelaunchError.helperLaunchFailed(helperURL, -1)"))
    }
}
