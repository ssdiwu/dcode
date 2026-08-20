import SwiftUI
import XCTest
@testable import PiDCode

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
        for phase in [SelfBuildModel.Phase.idle, .built, .failed] {
            let model = AppModel()
            model.selfBuild.phase = phase
            if phase == .built {
                model.selfBuild.candidate = SelfBuildCandidateInfo(
                    bundlePath: "/tmp/c", appVersion: "0.0.13", hostVersion: "0.0.13",
                    codesignValid: true, issue: nil
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
