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
                        "CFBundleShortVersionString": "0.0.26",
                        "CFBundleExecutable": "D Code",
                        "CFBundleIdentifier": "com.diwu.pidcode.selfbuild-test",
                        "CFBundlePackageType": "APPL",
                    ]).write(to: contents.appending(path: "Info.plist"))
                    try Data("{\"version\":\"0.0.26\"}\n".utf8).write(to: host.appending(path: "package.json"))
                    try Data("#!/bin/bash\nexit 0\n".utf8).write(to: macOS.appending(path: "D Code"))
                    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: macOS.appending(path: "D Code").path)
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

    func testRestartMarkerConsumesOnce() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: SelfBuildModels.restartMarkerKey)
        defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
        XCTAssertNil(SelfBuildModel.consumeRestartMarker())

        defaults.set(true, forKey: SelfBuildModels.restartMarkerKey)
        defaults.set("session-x", forKey: SelfBuildModels.pendingSessionKey)
        XCTAssertEqual(SelfBuildModel.consumeRestartMarker(), "session-x")
        XCTAssertNil(SelfBuildModel.consumeRestartMarker(), "标记只能消费一次")
    }

    func testSelfBuildSettingsPageRendersStates() {
        for phase in [SelfBuildModel.Phase.idle, .verifying, .built, .failed] {
            let model = AppModel()
            model.selfBuild.phase = phase
            if phase == .built {
                model.selfBuild.candidate = SelfBuildCandidateInfo(
                    bundlePath: "/tmp/c", appVersion: "0.0.26", hostVersion: "0.0.26",
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
