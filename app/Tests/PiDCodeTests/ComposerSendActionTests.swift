import AppKit
import SwiftUI
import XCTest
@testable import PiDCode

/// 发送动作视觉契约（设计系统 4.1 图标动作几何 + 7.6 Composer）。
///
/// 两条容易在重构里丢掉、而且只有像素能证明的性质：
/// 1. 暂不可发送时容器仍在——退化成裸 glyph 会让主动作比同一行的状态指示更弱；
/// 2. 禁用态 glyph 停在次级档，不被系统对 disabled label 的二次变暗压到提示档。
@MainActor
final class ComposerSendActionTests: XCTestCase {
    private let box: CGFloat = 40

    private func render(isEnabled: Bool) throws -> NSBitmapImageRep {
        let root = ZStack {
            Color.white
            Button {} label: { Image(systemName: "arrow.up") }
                .buttonStyle(SendActionStyle())
                .disabled(!isEnabled)
        }
        .frame(width: box, height: box)

        let host = NSHostingView(rootView: root)
        host.appearance = NSAppearance(named: .aqua)
        host.frame = NSRect(x: 0, y: 0, width: box, height: box)
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return rep
    }

    /// 返回 (非白像素数, 最深像素亮度, 最高饱和度)。
    private func stats(_ rep: NSBitmapImageRep) -> (ink: Int, darkest: Double, saturation: Double) {
        var ink = 0
        var darkest = 1.0
        var saturation = 0.0
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let r = Double(color.redComponent)
                let g = Double(color.greenComponent)
                let b = Double(color.blueComponent)
                let brightness = (r + g + b) / 3
                guard brightness < 0.98 else { continue }
                ink += 1
                darkest = min(darkest, brightness)
                saturation = max(saturation, max(r, g, b) - min(r, g, b))
            }
        }
        return (ink, darkest, saturation)
    }

    func testIdleSendButtonKeepsAVisibleContainer() throws {
        let idle = stats(try render(isEnabled: false))
        // 28pt 圆盘约 615pt²；裸 glyph 只有几十个像素。容器丢了这里就会掉到三位数以下。
        XCTAssertGreaterThan(idle.ink, 300, "暂不可发送时发送按钮没有容器，只剩裸 glyph")
        XCTAssertLessThan(
            SendActionStyle.idleSurfaceOpacity, 0.12,
            "暂不可发送的容器不能重到读成可发送"
        )
    }

    func testIdleGlyphStaysAtSecondaryTierNotHintTier() throws {
        let idle = stats(try render(isEnabled: false))
        // 次级档（0.5 黑）在白底约 0.5；提示档（0.26）约 0.74。
        // 若系统对 disabled label 的二次变暗又回来了，这里会升到 0.7 以上。
        XCTAssertLessThan(
            idle.darkest, 0.62,
            "禁用态 glyph 被二次变暗压到提示档，与占位符同权重"
        )
    }

    func testEnabledSendButtonUsesAccentFill() throws {
        let enabled = stats(try render(isEnabled: true))
        XCTAssertGreaterThan(enabled.saturation, 0.25, "可发送时容器不是 accent 填充")
        XCTAssertGreaterThan(enabled.ink, 300)
    }

    func testSurfaceIsNeverTransparentInEitherState() {
        for isEnabled in [true, false] {
            let surface = SendActionStyle.surfaceColor(isEnabled: isEnabled, isPressed: false)
            let resolved = NSColor(surface).usingColorSpace(.sRGB)
            XCTAssertGreaterThan(
                Double(resolved?.alphaComponent ?? 0), 0.02,
                "isEnabled=\(isEnabled) 时发送按钮容器是透明的"
            )
        }
    }
}
