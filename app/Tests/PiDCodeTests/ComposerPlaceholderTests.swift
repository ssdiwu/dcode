import AppKit
import XCTest
@testable import PiDCode

/// 占位符视觉契约（设计系统 3.4 hint 档 + 7.6 Composer）。
///
/// 占位符由 `ComposerNSTextView` 自己绘制在 text container 原点，因此可以离屏渲染、
/// 直接比较"占位符墨迹"与"同一串真实输入正文墨迹"的位置——这是手工偏移常数无法保证、
/// 也是自动测试真正能锁住的部分。颜色权重同样在这里锁死，避免再退回次级元信息档。
@MainActor
final class ComposerPlaceholderTests: XCTestCase {
    private let sample = ComposerPlaceholderCopy.idle

    private func makeTextView(fontSize: CGFloat) -> ComposerNSTextView {
        let textView = ComposerNSTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 66))
        textView.drawsBackground = false
        textView.isRichText = false
        textView.font = .systemFont(ofSize: fontSize, weight: .regular)
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        return textView
    }

    /// 返回视图内所有不透明像素的包围盒（左上原点，像素单位）。
    private func inkBounds(_ view: NSView) -> CGRect? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.05 else { continue }
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard minX <= maxX else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// 占位符与真实首行必须落在同一处：字号档位切换后也不允许错位。
    func testPlaceholderInkMatchesTypedFirstLineAtEveryFontScale() throws {
        for scale in DCodeInterfaceFontScale.allCases {
            let size = scale.composerBodyFontSize

            let placeholderView = makeTextView(fontSize: size)
            placeholderView.placeholder = sample
            let placeholderInk = try XCTUnwrap(inkBounds(placeholderView), "\(scale.label) 档占位符没有绘制任何墨迹")

            let typedView = makeTextView(fontSize: size)
            typedView.string = sample
            let typedInk = try XCTUnwrap(inkBounds(typedView), "\(scale.label) 档真实输入没有绘制任何墨迹")

            XCTAssertEqual(
                placeholderInk.minX, typedInk.minX, accuracy: 1,
                "\(scale.label) 档占位符与真实输入左边界错位"
            )
            XCTAssertEqual(
                placeholderInk.minY, typedInk.minY, accuracy: 1,
                "\(scale.label) 档占位符与真实输入首行顶边错位"
            )
            XCTAssertEqual(
                placeholderInk.width, typedInk.width, accuracy: 2,
                "\(scale.label) 档占位符与真实输入排版宽度不一致"
            )
        }
    }

    /// 提示档必须比次级元信息档更淡。macOS 的 `placeholderTextColor` 与
    /// `secondaryLabelColor` 同为 `0.5`，名字像提示档但权重不是，这里一并锁死。
    func testPlaceholderUsesHintTierNotSecondaryWeight() throws {
        let hint = try XCTUnwrap(NSColor.tertiaryLabelColor.usingColorSpace(.sRGB))
        let secondary = try XCTUnwrap(NSColor.secondaryLabelColor.usingColorSpace(.sRGB))
        let named = try XCTUnwrap(NSColor.placeholderTextColor.usingColorSpace(.sRGB))

        XCTAssertLessThan(hint.alphaComponent, secondary.alphaComponent - 0.15)
        XCTAssertEqual(named.alphaComponent, secondary.alphaComponent, accuracy: 0.01)

        let view = makeTextView(fontSize: DCodeInterfaceFontScale.standard.composerBodyFontSize)
        view.placeholder = sample
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)

        var darkest = 1.0
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB),
                      color.alphaComponent > 0.9 else { continue }
                darkest = min(darkest, Double(color.brightnessComponent))
            }
        }
        // 提示档在白底上的最深像素约 0.74（0.26 黑）；次级档会压到约 0.5。
        XCTAssertGreaterThan(darkest, 0.62, "占位符墨色过深，已退回次级元信息档")
    }

    /// 占位符是输入框的当前契约，不预告未实现能力，也不堆两条教学子句。
    func testPlaceholderCopyStaysWithinBudget() {
        for copy in ComposerPlaceholderCopy.all {
            XCTAssertLessThanOrEqual(
                ComposerPlaceholderCopy.displayWidth(copy),
                ComposerPlaceholderCopy.copyBudget,
                "占位符「\(copy)」超出文案预算"
            )
            XCTAssertFalse(copy.contains("\n"), "占位符「\(copy)」不是一行")
            XCTAssertFalse(copy.contains("；"), "占位符「\(copy)」用分号并列了两条教学")
        }
        // `@ 添加上下文` 的插入能力尚未实现，不在占位符里预告。
        XCTAssertFalse(ComposerPlaceholderCopy.idle.contains("@"))
    }
}
