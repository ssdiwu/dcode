import RelaunchCore
import SwiftUI
import XCTest
@testable import PiDCode

private final class SelfBuildEnvironmentBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: String] = [:]

    func store(_ environment: [String: String]) {
        lock.withLock { value = environment }
    }

    func load() -> [String: String] {
        lock.withLock { value }
    }
}

private final class SelfBuildSnapshotSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [SelfBuildSourceSnapshot]

    init(_ values: [SelfBuildSourceSnapshot]) {
        self.values = values
    }

    func next() -> SelfBuildSourceSnapshot {
        lock.withLock {
            if values.count > 1 { return values.removeFirst() }
            return values[0]
        }
    }
}

private final class SelfBuildRelaunchInvocationBox: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [RelaunchHelperRequest] = []
    private var terminationCount = 0
    private var helperSourcePaths: [String] = []
    private var markerObservedAtInstall: Bool?

    func recordRequest(_ request: RelaunchHelperRequest) {
        lock.withLock { requests.append(request) }
    }

    func recordTermination() {
        lock.withLock { terminationCount += 1 }
    }

    func recordHelperSource(_ url: URL) {
        lock.withLock { helperSourcePaths.append(url.standardizedFileURL.path) }
    }

    func recordMarkerAtInstall(_ value: Bool) {
        lock.withLock { markerObservedAtInstall = value }
    }

    func loadRequests() -> [RelaunchHelperRequest] { lock.withLock { requests } }
    func loadTerminationCount() -> Int { lock.withLock { terminationCount } }
    func loadHelperSourcePaths() -> [String] { lock.withLock { helperSourcePaths } }
    func loadMarkerObservedAtInstall() -> Bool? { lock.withLock { markerObservedAtInstall } }
}

private enum SelfBuildTestError: Error {
    case helperLaunchFailed
    case candidateInvalid
}
/// 0.0.13 自构建闭环：Runner、Swapper、恢复标记与设置页渲染。
@MainActor
final class SelfBuildTests: XCTestCase {
    private func temporaryDirectory(_ name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "dcode-selfbuild-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func restartSessionOpenValue(sessionID: String) -> JSONValue {
        let summary: JSONValue = .object([
            "path": .string("/tmp/harness/\(sessionID).jsonl"),
            "id": .string(sessionID),
            "cwd": .string("/tmp/harness"),
            "name": .null,
            "parentSessionPath": .null,
            "created": .string("2026-08-24T00:00:00.000Z"),
            "modified": .string("2026-08-24T00:00:00.000Z"),
            "messageCount": .number(0),
            "firstMessage": .string("恢复测试")
        ])
        let snapshot: JSONValue = .object([
            "summary": summary,
            "header": .object(["type": .string("session"), "version": .number(3), "id": .string(sessionID), "cwd": .string("/tmp/harness")]),
            "parentSessionId": .null,
            "leafId": .null,
            "currentPathId": .string("root"),
            "selectedPathId": .string("root"),
            "paths": .array([]),
            "entries": .array([]),
            "context": .object(["messageCount": .number(0), "model": .null, "thinkingLevel": .string("off")]),
            "activePlan": .null,
            "activeProposal": .null,
        ])
        let state: JSONValue = .object([
            "mode": .string("writable"),
            "sessionId": .string(sessionID),
            "sessionFile": .string("/tmp/harness/\(sessionID).jsonl"),
            "sessionName": .null,
            "cwd": .string("/tmp/harness"),
            "model": .null,
            "thinkingLevel": .string("off"),
            "activePlan": .null,
            "isStreaming": .bool(false),
            "runState": .null,
            "pendingMessageCount": .number(0),
            "contextUsage": .null,
            "fastMode": .null,
            "writable": .bool(true),
            "conflict": .null,
            "isCompacting": .bool(false),
        ])
        return .object([
            "created": .bool(false),
            "mode": .string("writable"),
            "snapshot": snapshot,
            "state": state,
            "extensions": .null,
        ])
    }

    private func sourceRoot(_ name: String) throws -> URL {
        let root = try temporaryDirectory(name)
        try Data("// test package\n".utf8).write(to: root.appending(path: "Package.swift"))
        let appDirectory = root.appending(path: "app", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: appDirectory, withIntermediateDirectories: true)
        let buildScript = appDirectory.appending(path: "build.sh")
        try Data("#!/bin/bash\nexit 0\n".utf8).write(to: buildScript)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: buildScript.path)
        let hostDirectory = root.appending(path: "host", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: hostDirectory, withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: hostDirectory.appending(path: "package.json"))
        return root
    }

    private func makeSignedCandidate(
        root: URL,
        manifest: SelfBuildCandidateManifest,
        version: String = "0.0.27"
    ) throws -> URL {
        let bundle = root
            .appending(path: SelfBuildModels.candidateDirectoryName, directoryHint: .isDirectory)
            .appending(path: SelfBuildModels.activeBundleName, directoryHint: .isDirectory)
        let contents = bundle.appending(path: "Contents", directoryHint: .isDirectory)
        let resources = contents.appending(path: "Resources", directoryHint: .isDirectory)
        let host = resources.appending(path: "host", directoryHint: .isDirectory)
        let macOS = contents.appending(path: "MacOS", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: host, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        try NSDictionary(dictionary: [
            "CFBundleShortVersionString": version,
            "CFBundleExecutable": "D Code",
            "CFBundleIdentifier": "com.diwu.pidcode.selfbuild-test",
            "CFBundlePackageType": "APPL",
        ]).write(to: contents.appending(path: "Info.plist"))
        try Data("{\"version\":\"\(version)\"}\n".utf8)
            .write(to: host.appending(path: "package.json"))
        let executable = macOS.appending(path: "D Code")
        try Data("#!/bin/bash\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let helper = resources.appending(path: SelfBuildRelaunchLauncher.helperResourceName)
        let helperExecutable = SelfBuildRelaunchLauncher.helperExecutableURL(helperAppURL: helper)
        try FileManager.default.createDirectory(
            at: helperExecutable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/bash\nexit 0\n".utf8).write(to: helperExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperExecutable.path)
        try NSDictionary(dictionary: [
            "CFBundleExecutable": SelfBuildRelaunchLauncher.helperExecutableName,
            "CFBundleIdentifier": "com.diwu.pidcode.relaunch-helper-test",
            "CFBundlePackageType": "APPL",
        ]).write(to: helper.appending(path: "Contents/Info.plist"))
        try JSONEncoder().encode(manifest).write(
            to: resources.appending(path: SelfBuildCandidateManifest.resourceName),
            options: [.atomic]
        )
        let codesign = Process()
        codesign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        codesign.arguments = ["--force", "--deep", "--sign", "-", bundle.path]
        codesign.standardOutput = FileHandle.nullDevice
        codesign.standardError = FileHandle.nullDevice
        try codesign.run()
        codesign.waitUntilExit()
        guard codesign.terminationStatus == 0 else {
            throw SelfBuildTestError.candidateInvalid
        }
        return bundle
    }

    private func makeActiveBundle(root: URL) throws {
        let active = root
            .appending(path: "dist", directoryHint: .isDirectory)
            .appending(path: SelfBuildModels.activeBundleName, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: active, withIntermediateDirectories: true)
        try Data("old-active\n".utf8).write(to: active.appending(path: "sentinel.txt"))
    }

    private func validChecks() -> [SelfBuildCommandResult] {
        [
            SelfBuildCommandResult(
                    id: "swift-tests", label: "Swift 回归", command: "swift test",
                    succeeded: true, exitCode: 0, durationMs: 10, outputTail: []
            ),
            SelfBuildCommandResult(
                    id: "host-tests", label: "Host 回归", command: "cd host && npm test",
                    succeeded: true, exitCode: 0, durationMs: 12, outputTail: []
            ),
        ]
    }

    private func validManifest(dirty: Bool = true) -> SelfBuildCandidateManifest {
        SelfBuildCandidateManifest(
            snapshot: SelfBuildSourceSnapshot(
                revision: String(repeating: "a", count: 40),
                dirty: dirty,
                changedFileCount: dirty ? 3 : 0,
                digest: String(repeating: "b", count: 64)
            ),
            verifications: validChecks(),
            generatedAt: "2026-08-23T00:00:00Z"
        )
    }

    private func runGit(_ arguments: [String], at root: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", root.path] + arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "git \(arguments.joined(separator: " "))")
    }

    func testRunnerReportsSuccessFailureAndTail() async throws {
        let root = try temporaryDirectory("runner")
        let script = root.appending(path: "script.sh")
        try Data("#!/bin/bash\necho line-1\necho line-2\nexit 0\n".utf8).write(to: script)
        let success = await SelfBuildRunner.run(
            scriptURL: script, additionalEnvironment: [:], currentDirectoryURL: root
        )
        XCTAssertTrue(success.succeeded)
        XCTAssertEqual(success.outputTail.suffix(2), ["line-1", "line-2"])

        try Data("#!/bin/bash\necho bad >&2\nexit 3\n".utf8).write(to: script)
        let failure = await SelfBuildRunner.run(
            scriptURL: script, additionalEnvironment: [:], currentDirectoryURL: root
        )
        XCTAssertFalse(failure.succeeded)
        XCTAssertEqual(failure.outputTail, ["bad"])

        let missing = await SelfBuildRunner.run(
            scriptURL: root.appending(path: "missing.sh"), additionalEnvironment: [:], currentDirectoryURL: root
        )
        XCTAssertFalse(missing.succeeded)
        XCTAssertFalse(missing.outputTail.isEmpty, "启动失败也要有可读输出")
    }

    func testRunnerPassesEnvironmentToScript() async throws {
        let root = try temporaryDirectory("env")
        let script = root.appending(path: "script.sh")
        try Data("#!/bin/bash\nif [ -n \"$PI_DCODE_DIST_DIR\" ]; then echo \"dist=$PI_DCODE_DIST_DIR\"; fi\nexit 0\n".utf8).write(to: script)
        let output = await SelfBuildRunner.run(
            scriptURL: script,
            additionalEnvironment: ["PI_DCODE_DIST_DIR": root.appending(path: "dist-candidate").path],
            currentDirectoryURL: root
        )
        XCTAssertEqual(output.outputTail.first, "dist=\(root.appending(path: "dist-candidate").path)")
    }

    func testSourceRootValidationAndDiscoveryAvoidPersonalHardCoding() throws {
        let root = try temporaryDirectory("source-root")
        XCTAssertFalse(SelfBuildSourceRootResolver.validate(root).isValid)
        try Data("// package\n".utf8).write(to: root.appending(path: "Package.swift"))
        try FileManager.default.createDirectory(at: root.appending(path: "app"), withIntermediateDirectories: true)
        try Data("#!/bin/bash\n".utf8).write(to: root.appending(path: "app/build.sh"))
        try FileManager.default.createDirectory(at: root.appending(path: "host"), withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: root.appending(path: "host/package.json"))

        let info = SelfBuildSourceRootResolver.validate(root)
        XCTAssertTrue(info.isValid)
        XCTAssertEqual(
            SelfBuildSourceRootResolver.discover(
                configuredPath: nil,
                environment: ["D_CODE_SELF_BUILD_ROOT": root.path],
                bundleURL: URL(fileURLWithPath: "/Applications/D Code.app"),
                currentDirectoryURL: URL(fileURLWithPath: "/")
            )?.rootURL,
            root.standardizedFileURL.resolvingSymlinksInPath()
        )
    }

    func testInvalidSourceSelectionKeepsExistingValidRoot() throws {
        let valid = try temporaryDirectory("valid-source-root")
        try Data("// package\n".utf8).write(to: valid.appending(path: "Package.swift"))
        try FileManager.default.createDirectory(at: valid.appending(path: "app"), withIntermediateDirectories: true)
        try Data("#!/bin/bash\n".utf8).write(to: valid.appending(path: "app/build.sh"))
        try FileManager.default.createDirectory(at: valid.appending(path: "host"), withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: valid.appending(path: "host/package.json"))
        let invalid = try temporaryDirectory("invalid-source-root")
        let model = SelfBuildModel(rootDirectory: valid)

        XCTAssertFalse(model.setSourceRoot(invalid, persist: false))
        XCTAssertEqual(model.rootDirectory, valid.standardizedFileURL.resolvingSymlinksInPath())
        XCTAssertNil(model.sourceRootIssue)
        XCTAssertNotNil(model.sourceRootSelectionIssue)
    }

    func testSourceSnapshotChangesForTrackedAndUntrackedWork() throws {
        let root = try temporaryDirectory("snapshot")
        try runGit(["init"], at: root)
        try runGit(["config", "user.email", "selfbuild@example.invalid"], at: root)
        try runGit(["config", "user.name", "Self Build Test"], at: root)
        try Data("base\n".utf8).write(to: root.appending(path: "tracked.txt"))
        try runGit(["add", "tracked.txt"], at: root)
        try runGit(["commit", "-m", "base"], at: root)

        let clean = try SelfBuildSourceSnapshotter.capture(rootURL: root)
        XCTAssertFalse(clean.dirty)
        XCTAssertEqual(clean.changedFileCount, 0)

        try Data("changed\n".utf8).write(to: root.appending(path: "tracked.txt"))
        try Data("new\n".utf8).write(to: root.appending(path: "untracked.txt"))
        let dirty = try SelfBuildSourceSnapshotter.capture(rootURL: root)
        XCTAssertTrue(dirty.dirty)
        XCTAssertEqual(dirty.changedFileCount, 2)
        XCTAssertNotEqual(dirty.digest, clean.digest)

        try Data("newer\n".utf8).write(to: root.appending(path: "untracked.txt"))
        XCTAssertNotEqual(try SelfBuildSourceSnapshotter.capture(rootURL: root).digest, dirty.digest)
    }

    func testCommandRunnerRecordsExitAndBoundedOutput() async throws {
        let root = try temporaryDirectory("command-runner")
        let script = root.appending(path: "check.sh")
        try Data("#!/bin/bash\necho verified\nexit 0\n".utf8).write(to: script)
        let result = await SelfBuildCommandRunner.run(SelfBuildCommandSpec(
            id: "check",
            label: "检查",
            executableURL: URL(fileURLWithPath: "/bin/bash"),
            arguments: [script.path],
            command: "check",
            workingDirectory: root
        ))
        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.outputTail, ["verified"])
    }

    func testHostVerificationUsesNodeAdjacentNPMWhenShellPathIsRestricted() throws {
        let root = try temporaryDirectory("host-toolchain")
        let bin = root.appending(path: "runtime/bin", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let node = bin.appending(path: "node")
        let npm = bin.appending(path: "npm")
        try Data().write(to: node)
        try Data().write(to: npm)

        let specs = SelfBuildVerificationRunner.commandSpecs(
            rootURL: root,
            environment: [
                "HOME": root.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "PI_DCODE_NODE_BIN": node.path,
            ]
        )
        let host = try XCTUnwrap(specs.first(where: { $0.id == "host-tests" }))

        XCTAssertEqual(host.executableURL, npm)
        XCTAssertEqual(host.environment["PATH"], "\(bin.path):/usr/bin:/bin:/usr/sbin:/sbin")
    }

    func testCandidateManifestRequiresTwoPassedVerifications() {
        XCTAssertTrue(validManifest().isValid)
        let failed = SelfBuildCandidateManifest(
            snapshot: SelfBuildSourceSnapshot(
                revision: String(repeating: "a", count: 40), dirty: true,
                changedFileCount: 1, digest: String(repeating: "b", count: 64)
            ),
            verifications: [
                SelfBuildCommandResult(
                    id: "swift-tests", label: "Swift 回归", command: "swift test",
                    succeeded: false, exitCode: 1, durationMs: 10, outputTail: ["failed"]
                ),
            ]
        )
        XCTAssertFalse(failed.isValid)

        let substituteChecks = SelfBuildCandidateManifest(
            snapshot: SelfBuildSourceSnapshot(
                revision: String(repeating: "a", count: 40), dirty: true,
                changedFileCount: 1, digest: String(repeating: "b", count: 64)
            ),
            verifications: [
                SelfBuildCommandResult(
                    id: "lint", label: "Lint", command: "lint",
                    succeeded: true, exitCode: 0, durationMs: 1, outputTail: []
                ),
                SelfBuildCommandResult(
                    id: "smoke", label: "Smoke", command: "smoke",
                    succeeded: true, exitCode: 0, durationMs: 1, outputTail: []
                ),
            ]
        )
        XCTAssertFalse(substituteChecks.isValid, "任意两条成功记录不能冒充 Swift 与 Host 完整门禁")
    }

    func testModelBuildAllowsDirtyLocalCandidateAndEmbedsManifest() async throws {
        let root = try temporaryDirectory("model-build")
        try Data("// package\n".utf8).write(to: root.appending(path: "Package.swift"))
        try FileManager.default.createDirectory(at: root.appending(path: "app"), withIntermediateDirectories: true)
        let buildScript = root.appending(path: "app/build.sh")
        try Data("#!/bin/bash\n".utf8).write(to: buildScript)
        try FileManager.default.createDirectory(at: root.appending(path: "host"), withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: root.appending(path: "host/package.json"))

        let snapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "c", count: 40),
            dirty: true,
            changedFileCount: 4,
            digest: String(repeating: "d", count: 64)
        )
        let checks = validChecks()
        let environmentBox = SelfBuildEnvironmentBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            verificationRunner: { _ in checks },
            buildRunner: { _, environment, _ in
                environmentBox.store(environment)
                guard let distPath = environment["PI_DCODE_DIST_DIR"],
                      let manifestPath = environment["PI_DCODE_SELF_BUILD_MANIFEST"] else {
                    return SelfBuildOutput(succeeded: false, durationMs: 1, outputTail: ["missing environment"])
                }
                let bundle = URL(fileURLWithPath: distPath, isDirectory: true).appending(path: "D Code.app")
                let contents = bundle.appending(path: "Contents")
                let resources = contents.appending(path: "Resources")
                let host = resources.appending(path: "host")
                let macOS = contents.appending(path: "MacOS")
                do {
                    try FileManager.default.createDirectory(at: host, withIntermediateDirectories: true)
                    try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
                    try NSDictionary(dictionary: [
                        "CFBundleShortVersionString": "0.0.27",
                        "CFBundleExecutable": "D Code",
                        "CFBundleIdentifier": "com.diwu.pidcode.selfbuild-test",
                        "CFBundlePackageType": "APPL",
                    ]).write(to: contents.appending(path: "Info.plist"))
                    try Data("{\"version\":\"0.0.27\"}\n".utf8).write(to: host.appending(path: "package.json"))
                    try Data("#!/bin/bash\nexit 0\n".utf8).write(to: macOS.appending(path: "D Code"))
                    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: macOS.appending(path: "D Code").path)
                    let helper = resources.appending(path: SelfBuildRelaunchLauncher.helperResourceName)
                    let helperExecutable = SelfBuildRelaunchLauncher.helperExecutableURL(helperAppURL: helper)
                    try FileManager.default.createDirectory(
                        at: helperExecutable.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try Data("#!/bin/bash\nexit 0\n".utf8).write(to: helperExecutable)
                    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperExecutable.path)
                    try NSDictionary(dictionary: [
                        "CFBundleExecutable": SelfBuildRelaunchLauncher.helperExecutableName,
                        "CFBundleIdentifier": "com.diwu.pidcode.relaunch-helper-test",
                        "CFBundlePackageType": "APPL",
                    ]).write(to: helper.appending(path: "Contents/Info.plist"))
                    try FileManager.default.copyItem(
                        at: URL(fileURLWithPath: manifestPath),
                        to: resources.appending(path: SelfBuildCandidateManifest.resourceName)
                    )
                    let codesign = Process()
                    codesign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
                    codesign.arguments = ["--force", "--deep", "--sign", "-", bundle.path]
                    codesign.standardOutput = FileHandle.nullDevice
                    codesign.standardError = FileHandle.nullDevice
                    try codesign.run()
                    codesign.waitUntilExit()
                    guard codesign.terminationStatus == 0 else {
                        return SelfBuildOutput(succeeded: false, durationMs: 1, outputTail: ["codesign failed"])
                    }
                    return SelfBuildOutput(succeeded: true, durationMs: 1, outputTail: ["built"])
                } catch {
                    return SelfBuildOutput(succeeded: false, durationMs: 1, outputTail: [error.localizedDescription])
                }
            },
            snapshotter: { _ in snapshot }
        )

        await model.build()

        XCTAssertEqual(model.phase, .built)
        XCTAssertTrue(model.candidate?.isReady == true)
        XCTAssertEqual(model.candidate?.manifest?.sourceDigest, snapshot.digest)
        XCTAssertEqual(environmentBox.load()["PI_DCODE_ALLOW_DIRTY_BUILD"], "1")
        XCTAssertNotNil(environmentBox.load()["PI_DCODE_SELF_BUILD_MANIFEST"])
    }

    func testVerificationFailureStopsBeforeCandidateBuild() async throws {
        let root = try temporaryDirectory("verification-failure")
        try Data("// package\n".utf8).write(to: root.appending(path: "Package.swift"))
        try FileManager.default.createDirectory(at: root.appending(path: "app"), withIntermediateDirectories: true)
        try Data("#!/bin/bash\n".utf8).write(to: root.appending(path: "app/build.sh"))
        try FileManager.default.createDirectory(at: root.appending(path: "host"), withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: root.appending(path: "host/package.json"))
        let snapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "e", count: 40), dirty: true,
            changedFileCount: 1, digest: String(repeating: "f", count: 64)
        )
        let environmentBox = SelfBuildEnvironmentBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            verificationRunner: { _ in [
                SelfBuildCommandResult(
                    id: "swift-tests", label: "Swift 回归", command: "swift test",
                    succeeded: false, exitCode: 1, durationMs: 1, outputTail: ["failed"]
                ),
            ] },
            buildRunner: { _, environment, _ in
                environmentBox.store(environment)
                return SelfBuildOutput(succeeded: true, durationMs: 1, outputTail: [])
            },
            snapshotter: { _ in snapshot }
        )

        await model.build()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertTrue(environmentBox.load().isEmpty, "自动门禁失败时不能调用候选构建")
        XCTAssertNil(model.candidate)
    }

    func testSourceChangeDuringBuildDiscardsCandidate() async throws {
        let root = try temporaryDirectory("source-change")
        try Data("// package\n".utf8).write(to: root.appending(path: "Package.swift"))
        try FileManager.default.createDirectory(at: root.appending(path: "app"), withIntermediateDirectories: true)
        try Data("#!/bin/bash\n".utf8).write(to: root.appending(path: "app/build.sh"))
        try FileManager.default.createDirectory(at: root.appending(path: "host"), withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: root.appending(path: "host/package.json"))
        let initial = SelfBuildSourceSnapshot(
            revision: String(repeating: "1", count: 40), dirty: true,
            changedFileCount: 1, digest: String(repeating: "2", count: 64)
        )
        let changed = SelfBuildSourceSnapshot(
            revision: initial.revision, dirty: true,
            changedFileCount: 2, digest: String(repeating: "3", count: 64)
        )
        let checks = validChecks()
        let snapshots = SelfBuildSnapshotSequence([initial, changed])
        let model = SelfBuildModel(
            rootDirectory: root,
            verificationRunner: { _ in checks },
            buildRunner: { _, _, _ in SelfBuildOutput(succeeded: true, durationMs: 1, outputTail: []) },
            snapshotter: { _ in snapshots.next() }
        )

        await model.build()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.issue, "构建期间源码发生变化；本次候选已废弃")
        XCTAssertNil(model.candidate)
    }

    func testSwapperInstallsRollsBackAndReportsMissingCandidate() throws {
        let dist = try temporaryDirectory("dist")
        let candidateRoot = try temporaryDirectory("candidate")
        let candidate = candidateRoot.appending(path: "D Code.app")
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)

        // 无 active：直接安装
        var result = SelfBuildBundleSwapper.installCandidate(candidateBundleURL: candidate, distDirectory: dist)
        XCTAssertTrue(result.succeeded)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dist.appending(path: "D Code.app").path))

        // 有 active：换出备份并安装新候选
        let candidate2 = candidateRoot.appending(path: "D Code.app")
        try FileManager.default.createDirectory(at: candidate2, withIntermediateDirectories: true)
        result = SelfBuildBundleSwapper.installCandidate(candidateBundleURL: candidate2, distDirectory: dist)
        XCTAssertTrue(result.succeeded)
        XCTAssertTrue(SelfBuildBundleSwapper.backupExists(distDirectory: dist), "替换后必须留有备份")

        // 回滚：backup ↔ active
        result = SelfBuildBundleSwapper.rollback(distDirectory: dist)
        XCTAssertTrue(result.succeeded)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dist.appending(path: "D Code.app").path))
        XCTAssertTrue(SelfBuildBundleSwapper.backupExists(distDirectory: dist))

        // 候选缺失
        result = SelfBuildBundleSwapper.installCandidate(
            candidateBundleURL: candidateRoot.appending(path: "missing.app"),
            distDirectory: dist
        )
        XCTAssertFalse(result.succeeded)
    }
    func testRestartUsesIndependentHelperAndConsumesCandidateOnce() async throws {
        let root = try sourceRoot("helper-success")
        let snapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "a", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "b", count: 64)
        )
        let manifest = SelfBuildCandidateManifest(snapshot: snapshot, verifications: validChecks())
        _ = try makeSignedCandidate(root: root, manifest: manifest)
        try makeActiveBundle(root: root)
        let box = SelfBuildRelaunchInvocationBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: root.appending(path: "dist", directoryHint: .isDirectory),
            snapshotter: { _ in snapshot },
            relaunchHelperLauncher: { request in box.recordRequest(request) },
            terminateApplication: { box.recordTermination() }
        )
        model.phase = .built
        model.candidate = SelfBuildCandidateValidator.validate(candidateBundleURL: model.candidateBundleURL)
        XCTAssertTrue(model.candidate?.isReady == true)
        let defaults = UserDefaults.standard
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }

        let outcome = await model.restartIntoCandidate(pendingSessionID: "session-helper")

        XCTAssertEqual(outcome, .restarted)
        XCTAssertEqual(box.loadRequests().count, 1, "交换后必须只启动一个独立 helper")
        XCTAssertEqual(box.loadTerminationCount(), 1)
        XCTAssertEqual(model.restartStage, .awaitingNewVersion)
        XCTAssertTrue(model.candidateWasConsumed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: model.candidateBundleURL.path), "候选移入 dist 后不得从空候选目录重试")
        XCTAssertTrue(SelfBuildModel.restartIntent(defaults: defaults) != nil, "新 App acknowledge 前 marker 必须保留")

        let retry = await model.restartIntoCandidate(pendingSessionID: "session-helper")
        guard case .validationFailed = retry else {
            return XCTFail("候选已消费后不得重复交换")
        }
        XCTAssertEqual(box.loadRequests().count, 1)
    }

    func testFirstUpgradeStagesHelperFromValidatedCandidateWhenActiveBundleHasNone() async throws {
        let root = try sourceRoot("candidate-helper-bootstrap")
        let snapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "a", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "b", count: 64)
        )
        let candidateURL = try makeSignedCandidate(
            root: root,
            manifest: SelfBuildCandidateManifest(snapshot: snapshot, verifications: validChecks())
        )
        try makeActiveBundle(root: root)
        let box = SelfBuildRelaunchInvocationBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: root.appending(path: "dist", directoryHint: .isDirectory),
            snapshotter: { _ in snapshot },
            relaunchHelperPreparer: { source, _ in
                box.recordHelperSource(source)
                guard source.standardizedFileURL == candidateURL.standardizedFileURL else {
                    throw SelfBuildRelaunchError.helperMissing(
                        SelfBuildRelaunchLauncher.helperURL(bundleURL: source)
                    )
                }
            },
            relaunchHelperLauncher: { request in box.recordRequest(request) },
            terminateApplication: { box.recordTermination() }
        )
        model.phase = .built
        model.candidate = SelfBuildCandidateValidator.validate(candidateBundleURL: model.candidateBundleURL)
        let defaults = UserDefaults.standard
        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }

        let outcome = await model.restartIntoCandidate(pendingSessionID: "session-bootstrap-helper")

        XCTAssertEqual(outcome, .restarted)
        XCTAssertEqual(box.loadHelperSourcePaths().first, candidateURL.standardizedFileURL.path)
        XCTAssertEqual(box.loadRequests().count, 1)
        XCTAssertEqual(box.loadTerminationCount(), 1)
    }

    func testRestartIntentIsPersistedBeforeCandidateInstallerRuns() async throws {
        let root = try sourceRoot("intent-before-swap")
        let snapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "a", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "b", count: 64)
        )
        _ = try makeSignedCandidate(
            root: root,
            manifest: SelfBuildCandidateManifest(snapshot: snapshot, verifications: validChecks())
        )
        try makeActiveBundle(root: root)
        let box = SelfBuildRelaunchInvocationBox()
        let defaults = UserDefaults.standard
        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: root.appending(path: "dist", directoryHint: .isDirectory),
            snapshotter: { _ in snapshot },
            candidateInstaller: { candidate, dist in
                box.recordMarkerAtInstall(SelfBuildModel.restartIntent() != nil)
                return SelfBuildBundleSwapper.installCandidate(
                    candidateBundleURL: candidate,
                    distDirectory: dist
                )
            },
            relaunchHelperLauncher: { request in box.recordRequest(request) },
            terminateApplication: { box.recordTermination() }
        )
        model.phase = .built
        model.candidate = SelfBuildCandidateValidator.validate(candidateBundleURL: model.candidateBundleURL)

        let outcome = await model.restartIntoCandidate(pendingSessionID: "session-intent-order")

        XCTAssertEqual(outcome, .restarted)
        XCTAssertEqual(box.loadMarkerObservedAtInstall(), true)
    }

    func testHelperCreationFailureKeepsCurrentAppAndClearsUnlaunchedMarker() async throws {
        let root = try sourceRoot("helper-failure")
        let snapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "a", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "b", count: 64)
        )
        let manifest = SelfBuildCandidateManifest(snapshot: snapshot, verifications: validChecks())
        _ = try makeSignedCandidate(root: root, manifest: manifest)
        try makeActiveBundle(root: root)
        let priorBackup = root.appending(path: "dist/\(SelfBuildModels.backupBundleName)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: priorBackup, withIntermediateDirectories: true)
        try Data("prior-backup\n".utf8).write(to: priorBackup.appending(path: "sentinel.txt"))
        let box = SelfBuildRelaunchInvocationBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: root.appending(path: "dist", directoryHint: .isDirectory),
            snapshotter: { _ in snapshot },
            relaunchHelperLauncher: { _ in
                box.recordRequest(RelaunchHelperRequest(
                    oldPID: 1,
                    appURL: URL(fileURLWithPath: "/tmp/dist/D Code.app"),
                    distDirectoryURL: URL(fileURLWithPath: "/tmp/dist"),
                    timeoutSeconds: 1
                ))
                throw SelfBuildTestError.helperLaunchFailed
            },
            terminateApplication: { box.recordTermination() }
        )
        model.phase = .built
        model.candidate = SelfBuildCandidateValidator.validate(candidateBundleURL: model.candidateBundleURL)
        XCTAssertTrue(model.candidate?.isReady == true)
        let defaults = UserDefaults.standard
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }

        let outcome = await model.restartIntoCandidate(pendingSessionID: "session-helper-failure")

        guard case .relaunchFailed = outcome else {
            return XCTFail("helper 创建失败必须返回可见失败")
        }
        XCTAssertEqual(box.loadTerminationCount(), 0, "helper 创建失败时当前 App 不得退出")
        XCTAssertNil(SelfBuildModel.restartIntent(defaults: defaults), "未启动 helper 的失败不能留下误导 marker")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appending(path: "dist/D Code.app/sentinel.txt").path))
        XCTAssertEqual(
            try String(contentsOf: root.appending(path: "dist/D Code.app/sentinel.txt"), encoding: .utf8),
            "old-active\n"
        )
        XCTAssertEqual(
            try String(contentsOf: priorBackup.appending(path: "sentinel.txt"), encoding: .utf8),
            "prior-backup\n"
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: model.candidateBundleURL.path))
        XCTAssertFalse(model.candidateWasConsumed)
        XCTAssertEqual(model.phase, .built, "身份完整恢复后应允许重试同一候选")
    }

    func testFinalizeFailureDoesNotLaunchAnOrphanRelaunchHelper() async throws {
        let root = try sourceRoot("finalize-helper-failure")
        try makeActiveBundle(root: root)
        let dist = root.appending(path: "dist", directoryHint: .isDirectory)
        let backup = dist.appending(path: SelfBuildModels.backupBundleName, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        let box = SelfBuildRelaunchInvocationBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: dist,
            relaunchHelperLauncher: { request in box.recordRequest(request) },
            terminateApplication: { box.recordTermination() }
        )
        XCTAssertTrue(model.beginRestartPreparation())
        XCTAssertTrue(model.prepareRollbackRestartBeforeSwap(
            kind: .selfEvolutionRollback,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-finalize-failure",
            selfEvolutionRunID: nil
        ))
        XCTAssertTrue(model.swapToBackup().succeeded)
        let outcome = await model.relaunchAfterPreparedSwap(
            hadActiveBundleBeforeSwap: true,
            finalize: { throw SelfBuildTestError.helperLaunchFailed }
        )

        guard case .relaunchFailed = outcome else {
            return XCTFail("回执 finalize 失败必须阻止重启")
        }
        XCTAssertEqual(box.loadRequests().count, 0, "finalize 失败前不得启动无法取消的 helper")
        XCTAssertEqual(box.loadTerminationCount(), 0)
    }

    func testFinalizedRollbackKeepsTargetBundleAndMarkerWhenHelperCannotLaunch() async throws {
        let root = try sourceRoot("finalized-helper-failure")
        try makeActiveBundle(root: root)
        let dist = root.appending(path: "dist", directoryHint: .isDirectory)
        let backup = dist.appending(path: SelfBuildModels.backupBundleName, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        try Data("rollback-target\n".utf8).write(to: backup.appending(path: "sentinel.txt"))
        let finalized = SelfBuildEnvironmentBox()
        let box = SelfBuildRelaunchInvocationBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: dist,
            relaunchHelperLauncher: { _ in throw SelfBuildTestError.helperLaunchFailed },
            terminateApplication: { box.recordTermination() }
        )
        let defaults = UserDefaults.standard
        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }
        XCTAssertTrue(model.beginRestartPreparation())
        XCTAssertTrue(model.prepareRollbackRestartBeforeSwap(
            kind: .selfEvolutionRollback,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-finalized-helper-failure",
            selfEvolutionRunID: nil
        ))
        XCTAssertTrue(model.swapToBackup().succeeded)

        let outcome = await model.relaunchAfterPreparedSwap(
            hadActiveBundleBeforeSwap: true,
            finalize: { finalized.store(["done": "true"]) }
        )

        guard case .relaunchFailed = outcome else {
            return XCTFail("helper 启动失败必须如实返回")
        }
        XCTAssertEqual(finalized.load()["done"], "true")
        XCTAssertEqual(
            try String(contentsOf: dist.appending(path: "D Code.app/sentinel.txt"), encoding: .utf8),
            "rollback-target\n",
            "不可逆回执完成后不得把 bundle 反向换回候选"
        )
        XCTAssertNotNil(SelfBuildModel.restartIntent(defaults: defaults), "人工恢复仍需 marker")
        XCTAssertEqual(box.loadTerminationCount(), 0)
    }

    func testSourceDigestMismatchRefusesExchangeBeforeMarkerOrHelper() async throws {
        let root = try sourceRoot("digest-mismatch")
        let original = SelfBuildSourceSnapshot(
            revision: String(repeating: "a", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "b", count: 64)
        )
        let changed = SelfBuildSourceSnapshot(
            revision: original.revision,
            dirty: true,
            changedFileCount: 4,
            digest: String(repeating: "c", count: 64)
        )
        let manifest = SelfBuildCandidateManifest(snapshot: original, verifications: validChecks())
        _ = try makeSignedCandidate(root: root, manifest: manifest)
        try makeActiveBundle(root: root)
        let box = SelfBuildRelaunchInvocationBox()
        let model = SelfBuildModel(
            rootDirectory: root,
            distDirectory: root.appending(path: "dist", directoryHint: .isDirectory),
            snapshotter: { _ in changed },
            relaunchHelperLauncher: { request in box.recordRequest(request) },
            terminateApplication: { box.recordTermination() }
        )
        model.phase = .built
        model.candidate = SelfBuildCandidateValidator.validate(candidateBundleURL: model.candidateBundleURL)
        XCTAssertTrue(model.candidate?.isReady == true)
        let defaults = UserDefaults.standard
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }

        let outcome = await model.restartIntoCandidate(pendingSessionID: "session-digest")

        guard case .validationFailed = outcome else {
            return XCTFail("source digest 不匹配时必须拒绝交换")
        }
        XCTAssertEqual(box.loadRequests().count, 0)
        XCTAssertEqual(box.loadTerminationCount(), 0)
        XCTAssertNil(SelfBuildModel.restartIntent(defaults: defaults))
        XCTAssertTrue(FileManager.default.fileExists(atPath: model.candidateBundleURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appending(path: "dist/D Code.app/sentinel.txt").path))
    }

    func testValidatorRejectsIncompleteCandidate() throws {
        let root = try temporaryDirectory("validator")
        let bundle = root.appending(path: "Broken.app")
        let contents = bundle.appending(path: "Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        // 缺 Info.plist
        var info = SelfBuildCandidateValidator.validate(candidateBundleURL: bundle)
        XCTAssertFalse(info.isReady)
        // 有 plist 但无 host / 未签名
        try NSDictionary(dictionary: ["CFBundleShortVersionString": "9.9.9"]).write(
            to: contents.appending(path: "Info.plist")
        )
        info = SelfBuildCandidateValidator.validate(candidateBundleURL: bundle)
        XCTAssertFalse(info.isReady, "缺少内嵌 Host 版本必须拒绝")
        XCTAssertEqual(info.appVersion, "9.9.9")
    }

    func testValidatorRequiresAnExecutableRelaunchHelperForTypedIntentCandidates() throws {
        let root = try sourceRoot("validator-helper")
        let candidate = try makeSignedCandidate(root: root, manifest: validManifest())
        let helper = SelfBuildRelaunchLauncher.helperURL(bundleURL: candidate)
        try FileManager.default.removeItem(at: helper)

        var info = SelfBuildCandidateValidator.validate(candidateBundleURL: candidate)
        XCTAssertEqual(info.issue, "候选缺少 Relaunch Helper")

        let helperExecutable = SelfBuildRelaunchLauncher.helperExecutableURL(helperAppURL: helper)
        try FileManager.default.createDirectory(
            at: helperExecutable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("helper".utf8).write(to: helperExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: helperExecutable.path)
        info = SelfBuildCandidateValidator.validate(candidateBundleURL: candidate)
        XCTAssertEqual(info.issue, "候选 Relaunch Helper 不可执行")
    }
    func testBootstrapAndRollbackUseTheSameRelaunchHelperContract() async throws {
        let defaults = UserDefaults.standard
        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }

        let bootstrapRoot = try sourceRoot("bootstrap-helper")
        try makeActiveBundle(root: bootstrapRoot)
        let bootstrapSnapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "a", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "b", count: 64)
        )
        let bootstrapBox = SelfBuildRelaunchInvocationBox()
        let bootstrapModel = SelfBuildModel(
            rootDirectory: bootstrapRoot,
            distDirectory: bootstrapRoot.appending(path: "dist", directoryHint: .isDirectory),
            snapshotter: { _ in bootstrapSnapshot },
            relaunchHelperLauncher: { request in bootstrapBox.recordRequest(request) },
            terminateApplication: { bootstrapBox.recordTermination() }
        )
        SelfBuildModel.persistRestartIntent(
            kind: .legacyBootstrap,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-bootstrap-helper",
            selfEvolutionRunID: nil,
            defaults: defaults
        )

        let bootstrapOutcome = await bootstrapModel.relaunchCurrentAppForRecovery(
            pendingSessionID: "session-bootstrap-helper"
        )

        XCTAssertEqual(bootstrapOutcome, .restarted)
        XCTAssertEqual(bootstrapBox.loadRequests().count, 1)
        XCTAssertEqual(bootstrapBox.loadTerminationCount(), 1)
        XCTAssertEqual(SelfBuildModel.restartIntent(defaults: defaults)?.kind, .legacyBootstrap)

        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        let rollbackRoot = try sourceRoot("rollback-helper")
        try makeActiveBundle(root: rollbackRoot)
        let dist = rollbackRoot.appending(path: "dist", directoryHint: .isDirectory)
        let backup = dist.appending(path: SelfBuildModels.backupBundleName, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        let rollbackSnapshot = SelfBuildSourceSnapshot(
            revision: String(repeating: "c", count: 40),
            dirty: true,
            changedFileCount: 3,
            digest: String(repeating: "d", count: 64)
        )
        let rollbackBox = SelfBuildRelaunchInvocationBox()
        let rollbackModel = SelfBuildModel(
            rootDirectory: rollbackRoot,
            distDirectory: dist,
            snapshotter: { _ in rollbackSnapshot },
            relaunchHelperLauncher: { request in rollbackBox.recordRequest(request) },
            terminateApplication: { rollbackBox.recordTermination() }
        )
        XCTAssertTrue(rollbackModel.beginRestartPreparation())
        XCTAssertTrue(rollbackModel.prepareRollbackRestartBeforeSwap(
            kind: .selfEvolutionRollback,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-rollback-helper",
            selfEvolutionRunID: nil
        ))
        XCTAssertTrue(rollbackModel.swapToBackup().succeeded)

        let rollbackOutcome = await rollbackModel.relaunchAfterPreparedSwap(
            hadActiveBundleBeforeSwap: true
        )

        XCTAssertEqual(rollbackOutcome, .restarted)
        XCTAssertEqual(rollbackBox.loadRequests().count, 1)
        XCTAssertEqual(rollbackBox.loadTerminationCount(), 1)
        XCTAssertEqual(SelfBuildModel.restartIntent(defaults: defaults)?.kind, .selfEvolutionRollback)
    }


    private func installRestartHostScript(
        _ harness: HostTestHarness,
        sessionID: String,
        openSucceeds: Bool
    ) async {
        let openValue = restartSessionOpenValue(sessionID: sessionID)
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                return HostTestHarness.helloValue()
            case "session.list":
                return .object(["sessions": .array([])])
            case "session.open":
                if openSucceeds { return openValue }
                throw PiHostClientError.hostFailure(HostErrorPayload(
                    code: "TEST_OPEN_FAILED",
                    message: "测试 Session 恢复失败",
                    details: nil
                ))
            case "session.getModels":
                return .object(["models": .array([]), "defaultModel": .null, "defaultThinkingLevel": .string("off")])
            case "session.getThinkingLevels":
                return .object(["levels": .array([.string("off")])])
            case "session.getCommands":
                return .object(["commands": .array([])])
            default:
                return .object([:])
            }
        }
    }

    func testRestartMarkerStaysUntilOrdinarySessionActuallyRestores() async throws {
        let defaults = UserDefaults.standard
        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        SelfBuildModel.persistRestartIntent(
            kind: .ordinary,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-marker-failure",
            selfEvolutionRunID: nil,
            defaults: defaults
        )
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }
        let harness = HostTestHarness()
        await installRestartHostScript(harness, sessionID: "session-marker-failure", openSucceeds: false)

        await harness.model.start()

        XCTAssertTrue(defaults.bool(forKey: SelfBuildModels.restartMarkerKey), "Session 恢复失败时 marker 必须保留")
        XCTAssertNotNil(SelfBuildModel.restartIntent(defaults: defaults))
        await harness.model.shutdown()
    }

    func testOrdinaryRestartMarkerAcknowledgesAfterSessionRestores() async throws {
        let defaults = UserDefaults.standard
        SelfBuildModel.acknowledgeRestartIntent(defaults: defaults)
        SelfBuildModel.persistRestartIntent(
            kind: .ordinary,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-marker-success",
            selfEvolutionRunID: nil,
            defaults: defaults
        )
        addTeardownBlock { SelfBuildModel.acknowledgeRestartIntent(defaults: defaults) }
        let harness = HostTestHarness()
        await installRestartHostScript(harness, sessionID: "session-marker-success", openSucceeds: true)

        await harness.model.start()

        XCTAssertEqual(harness.model.selectedSessionID, "session-marker-success")
        XCTAssertFalse(defaults.bool(forKey: SelfBuildModels.restartMarkerKey), "同一 Session 恢复成立后才 acknowledge marker")
        XCTAssertNil(SelfBuildModel.restartIntent(defaults: defaults))
        await harness.model.shutdown()
    }

    func testRestartMarkerConsumesOnce() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: SelfBuildModels.restartMarkerKey)
        defaults.removeObject(forKey: SelfBuildModels.restartIntentKindKey)
        defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
        defaults.removeObject(forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
        XCTAssertNil(SelfBuildModel.consumeRestartMarker())

        defaults.set(true, forKey: SelfBuildModels.restartMarkerKey)
        defaults.set("session-x", forKey: SelfBuildModels.pendingSessionKey)
        defaults.set("run-x", forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
        XCTAssertEqual(
            SelfBuildModel.restartIntent(),
            SelfBuildRestartIntent(
                kind: .selfEvolution,
                sessionID: "session-x",
                selfEvolutionRunID: "run-x"
            )
        )
        XCTAssertNotNil(SelfBuildModel.restartIntent(), "只读 intent 不得提前消费")
        XCTAssertEqual(SelfBuildModel.consumeRestartMarker(), "session-x")
        XCTAssertNil(SelfBuildModel.consumeRestartMarker(), "标记只能消费一次")
    }

    func testRestartIntentKindDistinguishesLegacyOrdinaryFullRollbackAndUnknown() {
        let defaults = UserDefaults.standard
        addTeardownBlock {
            defaults.removeObject(forKey: SelfBuildModels.restartMarkerKey)
            defaults.removeObject(forKey: SelfBuildModels.restartIntentKindKey)
            defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
            defaults.removeObject(forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
        }

        func read(kind: String?, runID: String? = nil) -> SelfBuildRestartIntentKind? {
            defaults.set(true, forKey: SelfBuildModels.restartMarkerKey)
            if let kind {
                defaults.set(kind, forKey: SelfBuildModels.restartIntentKindKey)
            } else {
                defaults.removeObject(forKey: SelfBuildModels.restartIntentKindKey)
            }
            if let runID {
                defaults.set(runID, forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
            } else {
                defaults.removeObject(forKey: SelfBuildModels.pendingSelfEvolutionRunKey)
            }
            return SelfBuildModel.restartIntent()?.kind
        }

        XCTAssertEqual(read(kind: nil), .legacyBootstrap, "v0.0.26 无类型 marker 只用于 Bootstrap")
        XCTAssertEqual(read(kind: "ordinary"), .ordinary)
        XCTAssertEqual(read(kind: "self-evolution", runID: "run-1"), .selfEvolution)
        XCTAssertEqual(read(kind: "self-evolution-rollback"), .selfEvolutionRollback)
        XCTAssertEqual(read(kind: "future-kind"), .unknown("future-kind"))
    }

    func testRollbackToLegacyTargetCannotLeaveTypedKindThatBypassesNextBootstrap() {
        let suiteName = "dcode-selfbuild-restart-compat-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        // 模拟新版本已有显式类型，再回滚到不认识该字段的 0.0.26。
        defaults.set("self-evolution-rollback", forKey: SelfBuildModels.restartIntentKindKey)
        SelfBuildModel.persistRestartIntent(
            kind: .selfEvolutionRollback,
            targetAppVersion: "0.0.26",
            pendingSessionID: "session-to-legacy",
            selfEvolutionRunID: nil,
            defaults: defaults
        )
        XCTAssertNil(defaults.string(forKey: SelfBuildModels.restartIntentKindKey))

        // 旧 0.0.26 消费 marker 后，再用旧逻辑只写 bool + Session 重启到 0.0.27。
        defaults.set(false, forKey: SelfBuildModels.restartMarkerKey)
        defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
        defaults.set(true, forKey: SelfBuildModels.restartMarkerKey)
        defaults.set("session-back-to-027", forKey: SelfBuildModels.pendingSessionKey)

        XCTAssertEqual(
            SelfBuildModel.restartIntent(defaults: defaults),
            SelfBuildRestartIntent(
                kind: .legacyBootstrap,
                sessionID: "session-back-to-027",
                selfEvolutionRunID: nil
            ),
            "旧版再次升级到 0.0.27 时必须建立 Bootstrap，不得复用回滚类型"
        )

        SelfBuildModel.persistRestartIntent(
            kind: .selfEvolutionRollback,
            targetAppVersion: "0.0.27",
            pendingSessionID: "session-typed-target",
            selfEvolutionRunID: nil,
            defaults: defaults
        )
        XCTAssertEqual(SelfBuildModel.restartIntent(defaults: defaults)?.kind, .selfEvolutionRollback)
    }

    func testSelfBuildSettingsPageRendersStates() {
        for phase in [SelfBuildModel.Phase.idle, .verifying, .built, .failed] {
            let model = AppModel()
            model.selfBuild.phase = phase
            if phase == .built {
                model.selfBuild.candidate = SelfBuildCandidateInfo(
                    bundlePath: "/tmp/c", appVersion: "0.0.27", hostVersion: "0.0.27",
                    codesignValid: true, manifest: validManifest(), issue: nil
                )
            }
            let host = NSHostingView(
                rootView: SelfBuildSettingsView().environment(model).frame(width: 540, height: 520)
            )
            host.layoutSubtreeIfNeeded()
            XCTAssertFalse(host.fittingSize == .zero)
        }
    }
}
