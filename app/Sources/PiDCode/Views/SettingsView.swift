import AppKit
import SwiftUI

enum WorkbenchPreferenceKey {
    static let sidebarUserHidden = "dcode.sidebar.userHidden"
    static let inspectorUserHidden = "dcode.inspector.userHidden"
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
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @AppStorage(WorkbenchPreferenceKey.sidebarUserHidden) private var sidebarUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.inspectorUserHidden) private var inspectorUserHidden = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("外观")
                .font(.title2.weight(.semibold))

            Picker("外观", selection: appearance) {
                ForEach(AppAppearance.allCases) { option in
                    Text(option.label)
                        .tag(option)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.large)
            .accessibilityLabel("外观")
            .accessibilityHint("选择跟随系统、浅色或深色外观")

            Text("“系统”会跟随 macOS 的当前外观；浅色与深色会覆盖系统设置。")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            Text("工作台布局")
                .font(.title2.weight(.semibold))

            Toggle("中宽与宽窗口中显示左栏", isOn: showSidebar)
                .accessibilityLabel("中宽与宽窗口中显示左栏")
                .accessibilityHint("立即更新可并排的工作台布局，并在下次启动时保留")

            Toggle("宽窗口中显示工作检查器", isOn: showInspector)
                .accessibilityLabel("宽窗口中显示工作检查器")
                .accessibilityHint("中等与窄窗口仍会按可用宽度自动切换为覆盖面板")

            Text("窄窗口始终优先保留对话空间，左右栏按需以覆盖面板打开，不受并排布局偏好强制展开。")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            HStack {
                Button("恢复默认布局") {
                    sidebarUserHidden = false
                    inspectorUserHidden = false
                }
                .accessibilityLabel("恢复默认布局")
                Spacer()
            }
        }
        .padding(24)
        .frame(width: 460)
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
}
