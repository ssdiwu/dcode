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
    static let prominentIconActionTarget: CGFloat = 36
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
