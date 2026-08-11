import SwiftUI

enum PiDCodeMetrics {
    static let contentMaxWidth: CGFloat = 820
    static let compactRadius: CGFloat = 8
    static let controlRadius: CGFloat = 10
    static let messageRadius: CGFloat = 14
    static let minimumTarget: CGFloat = 40
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
            .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
            .contentShape(Rectangle())
            .background(configuration.isPressed ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.97 : 1))
            .animation(reduceMotion ? nil : .smooth(duration: 0.12), value: configuration.isPressed)
    }
}

extension View {
    func dCodeAccessibleButton(_ label: String) -> some View {
        accessibilityLabel(Text(label))
            .help(label)
    }
}

extension Date {
    var piDCodeRelativeLabel: String {
        formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
