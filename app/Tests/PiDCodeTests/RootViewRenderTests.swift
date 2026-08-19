import SwiftUI
import XCTest
import ViewInspector
@testable import PiDCode

/// 渲染冒烟测试。
///
/// ViewInspector 0.10.3 尚不支持 `@Environment(AppModel.self)`（修复在未发布的 0.10.4），
/// 因此这里分两层：
/// - 环境无关视图用 ViewInspector 做结构断言；
/// - 依赖 AppModel 的主界面用 `NSHostingView` 真实渲染，验证关键状态不崩、可布局。
@MainActor
final class RootViewRenderTests: XCTestCase {
    func testUserHomeViewRendersPrimaryActions() throws {
        let sut = UserHomeView(
            newSession: {},
            newProject: {},
            canCreateSession: true,
            canCreateProject: true
        )

        XCTAssertEqual(try sut.inspect().find(text: "D Code").string(), "D Code")
        XCTAssertEqual(try sut.inspect().find(text: "从最近会话继续，或为一组源文件夹建立项目。").string(), "从最近会话继续，或为一组源文件夹建立项目。")
        XCTAssertNotNil(try? sut.inspect().find(button: "新建会话"))
        XCTAssertNotNil(try? sut.inspect().find(button: "新建项目…"))
    }

    func testRootViewRendersIdleStateUnderRealHosting() {
        let model = AppModel()
        model.connectionState = .idle

        let host = NSHostingView(
            rootView: RootView()
                .environment(model)
                .frame(width: 1_280, height: 800)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero, "真实宿主必须完成布局")
        XCTAssertEqual(model.connectionState, .idle, "渲染不得改变连接状态")
    }

    func testRootViewRendersReadyStateWithOpenSessionUnderRealHosting() {
        let model = AppModel()
        model.connectionState = .ready
        model.selectedSessionID = "session-render"
        model.transcript = [
            TranscriptItem(
                id: "round-1",
                role: .assistant,
                timestamp: Date(timeIntervalSince1970: 1_800_000_000),
                blocks: [.text(id: "text-1", value: "渲染冒烟：助手轮次")]
            ),
        ]

        let host = NSHostingView(
            rootView: RootView()
                .environment(model)
                .frame(width: 1_280, height: 800)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero, "真实宿主必须完成布局")
    }
}
