import AppKit
import SwiftUI

enum AboutAppMetadata {
    static let authorURL = URL(string: "https://github.com/ssdiwu")!
    static let projectURL = URL(string: "https://github.com/ssdiwu/dcode")!

    static func versionText(infoDictionary: [String: Any]) -> String {
        let shortVersion = infoDictionary["CFBundleShortVersionString"] as? String
        let build = infoDictionary["CFBundleVersion"] as? String
        switch (shortVersion?.nilIfEmpty, build?.nilIfEmpty) {
        case let (.some(version), .some(build)):
            return "版本 \(version)（\(build)）"
        case let (.some(version), .none):
            return "版本 \(version)"
        case let (.none, .some(build)):
            return "构建 \(build)"
        case (.none, .none):
            return "版本未知"
        }
    }
}

struct AboutView: View {
    private var versionText: String {
        AboutAppMetadata.versionText(infoDictionary: Bundle.main.infoDictionary ?? [:])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingStandard) {
                    Text("关于 D Code")
                        .font(.largeTitle.weight(.semibold))
                    Text("D Code 的应用信息、作者与项目入口。")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }

                HStack(alignment: .center, spacing: PiDCodeMetrics.spacingSection) {
                    Image(nsImage: NSApplication.shared.applicationIconImage)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .frame(width: 96, height: 96)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                        Text("D Code")
                            .font(.title.weight(.semibold))
                        Text(versionText)
                            .font(.body.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }

                VStack(spacing: 0) {
                    AboutLinkRow(
                        title: "作者 GitHub",
                        detail: "ssdiwu",
                        systemImage: "person.crop.circle",
                        destination: AboutAppMetadata.authorURL
                    )

                    Divider().padding(.leading, 56)

                    AboutLinkRow(
                        title: "项目 GitHub",
                        detail: "ssdiwu/dcode",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        destination: AboutAppMetadata.projectURL
                    )
                }
                .background(
                    Color.primary.opacity(0.035),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.09), lineWidth: 1)
                }
            }
            .frame(maxWidth: 780, alignment: .leading)
            .padding(.horizontal, 48)
            .padding(.vertical, 44)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("关于 D Code")
    }
}

private struct AboutLinkRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let destination: URL

    var body: some View {
        Link(destination: destination) {
            HStack(spacing: PiDCodeMetrics.spacingGroup) {
                Image(systemName: systemImage)
                    .frame(width: PiDCodeMetrics.actionGlyphBox)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                    Text(title)
                        .font(.body.weight(.medium))
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: PiDCodeMetrics.spacingSection)

                Image(systemName: "arrow.up.right")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title)，\(detail)")
        .accessibilityHint("在浏览器中打开")
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
