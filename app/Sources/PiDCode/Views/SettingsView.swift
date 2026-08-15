import AppKit
import SwiftUI

enum WorkbenchPreferenceKey {
    static let sidebarUserHidden = "dcode.sidebar.userHidden"
    static let inspectorUserHidden = "dcode.inspector.userHidden"
    static let sidebarWidth = "dcode.sidebar.width"
    static let inspectorWidth = "dcode.inspector.width"
}

enum AppAppearance: String, CaseIterable, Identifiable {
    static let storageKey = "dcode.appearance"

    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }

    var appearanceName: NSAppearance.Name? {
        switch self {
        case .system: nil
        case .light: .aqua
        case .dark: .darkAqua
        }
    }

    @MainActor
    func apply() {
        NSApplication.shared.appearance = appearanceName.flatMap(NSAppearance.init(named:))
    }

    static func resolve(_ rawValue: String) -> AppAppearance {
        AppAppearance(rawValue: rawValue) ?? .system
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @AppStorage(WorkbenchPreferenceKey.sidebarUserHidden) private var sidebarUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.inspectorUserHidden) private var inspectorUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.sidebarWidth) private var sidebarWidth = Double(WorkbenchLayoutPolicy.defaultSidebarWidth)
    @AppStorage(WorkbenchPreferenceKey.inspectorWidth) private var inspectorWidth = Double(WorkbenchLayoutPolicy.defaultInspectorWidth)

    let page: SettingsPage
    let navigationWidth: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            settingsNavigation
                .frame(width: navigationWidth)
                .frame(maxHeight: .infinity)

            pageContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var settingsNavigation: some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingStandard) {
            Button {
                model.dismissSettings()
            } label: {
                Label("返回工作台", systemImage: "arrow.left")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(height: PiDCodeMetrics.minimumTarget)
            .dCodeAccessibleButton("返回工作台")

            Text("设置")
                .font(.title2.weight(.semibold))
                .padding(.top, PiDCodeMetrics.spacingStandard)
                .padding(.bottom, PiDCodeMetrics.spacingTight)

            Text("偏好")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, PiDCodeMetrics.spacingStandard)

            SettingsNavigationRow(
                title: "外观",
                systemImage: "circle.lefthalf.filled",
                selected: page == .appearance
            ) {
                model.presentSettings(.appearance)
            }

            SettingsNavigationRow(
                title: "工作台",
                systemImage: "rectangle.3.group",
                selected: page == .workbench
            ) {
                model.presentSettings(.workbench)
            }

            Text("会话")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, PiDCodeMetrics.spacingStandard)
                .padding(.top, PiDCodeMetrics.spacingSection)

            SettingsNavigationRow(
                title: "已归档会话",
                systemImage: "archivebox",
                badge: archivedSessionCount,
                selected: page == .archivedSessions
            ) {
                model.presentArchivedSessions()
            }

            Text("应用")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, PiDCodeMetrics.spacingStandard)
                .padding(.top, PiDCodeMetrics.spacingSection)

            SettingsNavigationRow(
                title: "关于 D Code",
                systemImage: "info.circle",
                selected: page == .about
            ) {
                model.presentSettings(.about)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, PiDCodeMetrics.spacingSection)
        .padding(.vertical, PiDCodeMetrics.spacingSection)
    }

    @ViewBuilder
    private var pageContent: some View {
        switch page {
        case .appearance:
            SettingsPageContainer(
                title: "外观",
                subtitle: "选择 D Code 在这台 Mac 上的显示方式。"
            ) {
                SettingsGroup {
                    SettingsValueRow(
                        title: "应用外观",
                        detail: "跟随 macOS，或固定使用浅色、深色外观。"
                    ) {
                        Picker("应用外观", selection: appearance) {
                            ForEach(AppAppearance.allCases) { option in
                                Text(option.label)
                                    .tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 220)
                        .accessibilityHint("选择跟随系统、浅色或深色外观")
                    }
                }
            }

        case .workbench:
            SettingsPageContainer(
                title: "工作台",
                subtitle: "管理会话栏、信息检查器与已保存的栏位宽度。"
            ) {
                SettingsGroup {
                    SettingsValueRow(
                        title: "空间允许时显示会话栏",
                        detail: "空间不足时，会话栏改为按需覆盖，不改变这个偏好。"
                    ) {
                        Toggle("空间允许时显示会话栏", isOn: showSidebar)
                            .labelsHidden()
                            .toggleStyle(.switch)
                    }

                    Divider().padding(.leading, 20)

                    SettingsValueRow(
                        title: "显示信息检查器",
                        detail: "中宽与宽窗口中常驻；窄窗口按需覆盖。"
                    ) {
                        Toggle("显示信息检查器", isOn: showInspector)
                            .labelsHidden()
                            .toggleStyle(.switch)
                    }

                    Divider().padding(.leading, 20)

                    Button {
                        restoreDefaultLayout()
                    } label: {
                        Label("恢复默认布局", systemImage: "arrow.counterclockwise")
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 20)
                    .accessibilityHint("恢复会话栏、信息检查器和两侧宽度的默认设置")
                }

                Text("可在任何显示会话栏、设置导航或信息检查器的页面拖动内侧边缘调宽；所有页面会立即继承，并自动保存。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, PiDCodeMetrics.spacingTight)
            }

        case .archivedSessions:
            ArchivedSessionsView()

        case .about:
            AboutView()
        }
    }

    private var appearance: Binding<AppAppearance> {
        Binding(
            get: { AppAppearance.resolve(appearanceRawValue) },
            set: { newValue in
                appearanceRawValue = newValue.rawValue
                newValue.apply()
            }
        )
    }

    private var showSidebar: Binding<Bool> {
        Binding(
            get: { !sidebarUserHidden },
            set: { sidebarUserHidden = !$0 }
        )
    }

    private var showInspector: Binding<Bool> {
        Binding(
            get: { !inspectorUserHidden },
            set: { inspectorUserHidden = !$0 }
        )
    }

    private var archivedSessionCount: Int {
        model.archivedSessions.count + (model.pendingArchiveRetry == nil ? 0 : 1)
    }

    private func restoreDefaultLayout() {
        sidebarUserHidden = false
        inspectorUserHidden = false
        sidebarWidth = Double(WorkbenchLayoutPolicy.defaultSidebarWidth)
        inspectorWidth = Double(WorkbenchLayoutPolicy.defaultInspectorWidth)
    }
}

private struct SettingsNavigationRow: View {
    let title: String
    let systemImage: String
    var badge: Int?
    let selected: Bool
    let action: () -> Void

    init(
        title: String,
        systemImage: String,
        badge: Int? = nil,
        selected: Bool,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.badge = badge
        self.selected = selected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: PiDCodeMetrics.spacingGroup) {
                Image(systemName: systemImage)
                    .frame(width: PiDCodeMetrics.actionGlyphBox)
                    .accessibilityHidden(true)
                Text(title)
                    .lineLimit(1)
                Spacer(minLength: PiDCodeMetrics.spacingStandard)
                if let badge, badge > 0 {
                    Text("\(badge)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, PiDCodeMetrics.spacingGroup)
            .frame(maxWidth: .infinity, minHeight: PiDCodeMetrics.minimumTarget, alignment: .leading)
            .background(
                selected ? Color.primary.opacity(0.09) : .clear,
                in: RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct SettingsPageContainer<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingStandard) {
                    Text(title)
                        .font(.largeTitle.weight(.semibold))
                    Text(subtitle)
                        .font(.body)
                        .foregroundStyle(.secondary)
                }

                content()
            }
            .frame(maxWidth: 780, alignment: .leading)
            .padding(.horizontal, 48)
            .padding(.vertical, 44)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollContentBackground(.hidden)
    }
}

private struct SettingsGroup<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            content()
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
}

private struct SettingsValueRow<Trailing: View>: View {
    let title: String
    let detail: String
    let trailing: Trailing

    init(
        title: String,
        detail: String,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.detail = detail
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: PiDCodeMetrics.spacingSection) {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                Text(title)
                    .font(.body.weight(.medium))
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: PiDCodeMetrics.spacingSection)
            trailing
        }
        .padding(.horizontal, 20)
        .padding(.vertical, PiDCodeMetrics.spacingGroup)
        .frame(minHeight: 72)
    }
}
