import SwiftUI

enum PiDCodeMetrics {
    static let gridUnit: CGFloat = 4
    static let spacingTight: CGFloat = 4
    static let spacingStandard: CGFloat = 8
    static let spacingGroup: CGFloat = 12
    static let spacingSection: CGFloat = 16
    static let contentMaxWidth: CGFloat = 820
    static let compactRadius: CGFloat = 8
    static let controlRadius: CGFloat = 10
    static let messageRadius: CGFloat = 14
    static let minimumTarget: CGFloat = 40
    static let compactControlHeight: CGFloat = 32
    static let navigationRowHeight: CGFloat = 36
    static let iconActionTarget: CGFloat = 32
    static let iconActionSurface: CGFloat = 28
    static let actionGlyphPointSize: CGFloat = 13
    static let actionGlyphBox: CGFloat = 18
    static let toolbarIconTarget: CGFloat = 28
    static let floatingSurfaceRadius: CGFloat = 18
    static let workspaceCanvasRadius: CGFloat = 14
    static let workbenchInset: CGFloat = 12
    static let windowTopBarHeight: CGFloat = navigationRowHeight
    static let windowControlsReservedWidth: CGFloat = 88
}

enum DCodeSurfaceRole: Equatable, Sendable {
    case canvas
    case navigation
    case raised

    var color: Color {
        switch self {
        case .canvas, .navigation:
            Color(nsColor: .windowBackgroundColor)
        case .raised:
            Color(nsColor: .textBackgroundColor)
        }
    }
}

enum DCodeWorkbenchSurfacePolicy {
    static let windowChrome: DCodeSurfaceRole = .canvas
    static let centralCanvas: DCodeSurfaceRole = .canvas
    static let inspectorRail: DCodeSurfaceRole = .canvas
    static let sidebar: DCodeSurfaceRole = .navigation
    static let floatingSurface: DCodeSurfaceRole = .raised
}

private struct DCodeFloatingSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(DCodeWorkbenchSurfacePolicy.floatingSurface.color, in: shape)
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(
                    Color.primary.opacity(0.11),
                    lineWidth: 1
                )
            }
            .shadow(
                color: .black.opacity(colorScheme == .dark ? 0.30 : 0.11),
                radius: 16,
                y: 6
            )
    }
}

struct DCodeSidebarBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            DCodeWorkbenchSurfacePolicy.sidebar.color
            Color.primary.opacity(colorScheme == .dark ? 0.035 : 0.022)
        }
    }
}

private struct DCodeLeadingRoundedRectangle: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let resolvedRadius = min(radius, rect.width / 2, rect.height / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + resolvedRadius, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + resolvedRadius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - resolvedRadius),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + resolvedRadius))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + resolvedRadius, y: rect.minY),
            control: CGPoint(x: rect.minX, y: rect.minY)
        )
        path.closeSubpath()
        return path
    }
}

/// The main workspace is one continuous canvas laid over the navigation surface.
/// Its leading curve establishes hierarchy without casting another shade into navigation.
struct DCodeMainWorkspaceBackground: View {
    let wrappedByNavigation: Bool

    var body: some View {
        if wrappedByNavigation {
            DCodeWorkbenchSurfacePolicy.centralCanvas.color
                .clipShape(
                    DCodeLeadingRoundedRectangle(radius: PiDCodeMetrics.workspaceCanvasRadius)
                )
        } else {
            DCodeWorkbenchSurfacePolicy.centralCanvas.color
        }
    }
}

private struct DCodeSidebarSurfaceModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.background { DCodeSidebarBackground() }
    }
}

struct IconActionGlyph: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: PiDCodeMetrics.actionGlyphPointSize, weight: .medium))
            .symbolRenderingMode(.monochrome)
            .frame(
                width: PiDCodeMetrics.actionGlyphBox,
                height: PiDCodeMetrics.actionGlyphBox,
                alignment: .center
            )
            .accessibilityHidden(true)
    }
}

struct StatusPill: View {
    let label: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.1), in: Capsule())
            .accessibilityElement(children: .combine)
    }
}

struct IconActionStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: PiDCodeMetrics.actionGlyphPointSize, weight: .medium))
            .symbolRenderingMode(.monochrome)
            .frame(width: PiDCodeMetrics.iconActionSurface, height: PiDCodeMetrics.iconActionSurface)
            .background(
                configuration.isPressed ? Color.primary.opacity(0.08) : .clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .frame(width: PiDCodeMetrics.iconActionTarget, height: PiDCodeMetrics.iconActionTarget)
            .contentShape(Rectangle())
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.97 : 1))
            .animation(reduceMotion ? nil : .smooth(duration: 0.12), value: configuration.isPressed)
    }
}

/// 发送动作：容器常在，权重分档。
///
/// accent 填充圆盘 = 现在可发送；中性极低填充圆盘 = 按钮在这里、但暂不可发送。
/// 禁用态不能退化成"没有容器的裸 glyph"——那样主动作在控制行里比状态指示更弱，
/// 用户找不到按钮在哪。禁用观感由本 style 自己表达，不依赖系统对 disabled label
/// 的二次变暗：`Color.secondary` 再被系统压一层会掉到提示档，和占位符一样淡。
struct SendActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 暂不可发送时的容器填充：足以看出"这里有个按钮"，不足以读成"可以按了"。
    static let idleSurfaceOpacity: Double = 0.07

    static func glyphColor(isEnabled: Bool) -> Color {
        isEnabled ? .white : .secondary
    }

    static func surfaceColor(isEnabled: Bool, isPressed: Bool) -> Color {
        guard isEnabled else { return Color.primary.opacity(idleSurfaceOpacity) }
        return isPressed ? Color.accentColor.opacity(0.82) : Color.accentColor
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(Self.glyphColor(isEnabled: isEnabled))
            .frame(
                width: PiDCodeMetrics.iconActionSurface,
                height: PiDCodeMetrics.iconActionSurface
            )
            .background(
                Self.surfaceColor(isEnabled: isEnabled, isPressed: configuration.isPressed),
                in: Circle()
            )
            .frame(
                width: PiDCodeMetrics.iconActionTarget,
                height: PiDCodeMetrics.iconActionTarget
            )
            .contentShape(Rectangle())
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.97 : 1))
            .animation(reduceMotion ? nil : .smooth(duration: 0.12), value: configuration.isPressed)
    }
}

extension View {
    func dCodeAccessibleButton(_ label: String) -> some View {
        help(label)
            .accessibilityLabel(Text(label))
    }

    func dCodeFloatingSurface(
        cornerRadius: CGFloat = PiDCodeMetrics.floatingSurfaceRadius
    ) -> some View {
        modifier(DCodeFloatingSurfaceModifier(cornerRadius: cornerRadius))
    }

    func dCodeSidebarSurface() -> some View {
        modifier(DCodeSidebarSurfaceModifier())
    }
}

extension Date {
    var piDCodeRelativeLabel: String {
        formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}

/// 界面字号档位（设置 > 外观）。
/// 缩放经系统 Dynamic Type 语义层级实现：标准档跟随系统设置，
/// 紧凑 / 大档在系统值基础上整体下移 / 上移一级并封顶在常规层级内，
/// 因此全部语义字号（body / caption / headline …）同时缩放，不逐处改字号。
enum DCodeInterfaceFontScale: String, CaseIterable, Identifiable {
    static let storageKey = "dcode.appearance.fontScale"

    case compact
    case standard
    case large

    var id: String { rawValue }

    var label: String {
        switch self {
        case .compact: "紧凑"
        case .standard: "标准"
        case .large: "大"
        }
    }

    static func resolve(_ rawValue: String) -> DCodeInterfaceFontScale {
        DCodeInterfaceFontScale(rawValue: rawValue) ?? .standard
    }

    /// 返回nil表示不覆盖环境（完全跟随系统 Dynamic Type）。
    func dynamicTypeSizeOverride(basedOn systemSize: DynamicTypeSize) -> DynamicTypeSize? {
        let steps: [DynamicTypeSize] = [
            .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
        ]
        guard let index = steps.firstIndex(of: systemSize.clampedToRegularRange) else { return nil }
        switch self {
        case .standard:
            return nil
        case .compact:
            return steps[max(0, index - 1)]
        case .large:
            return steps[min(steps.count - 1, index + 1)]
        }
    }
}

extension DynamicTypeSize {
    /// 无障碍特大档不参与界面字号设置，避免破坏三栏与行高几何。
    var clampedToRegularRange: DynamicTypeSize {
        if !isAccessibilitySize { return self }
        return .xxxLarge
    }
}

extension DCodeInterfaceFontScale {
    /// Composer 正文是 AppKit 文本视图，不随 SwiftUI Dynamic Type 环境缩放；
    /// 占位符与输入正文共用这里推导的显式字号，保证非标准档下两者视觉一致。
    var composerBodyFontSize: CGFloat {
        switch self {
        case .compact: 12
        case .standard: 13
        case .large: 14.5
        }
    }
}
