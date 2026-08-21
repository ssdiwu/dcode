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

    @AppStorage(DCodeInterfaceFontScale.storageKey) private var interfaceFontScaleRawValue = DCodeInterfaceFontScale.standard.rawValue
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

            Text("Pi")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, PiDCodeMetrics.spacingStandard)

            SettingsNavigationRow(
                title: "模型",
                systemImage: "cpu",
                selected: page == .models
            ) {
                model.presentSettings(.models)
            }

            SettingsNavigationRow(
                title: "本机资源",
                systemImage: "shippingbox",
                selected: page == .resources
            ) {
                model.presentSettings(.resources)
            }

            Text("偏好")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, PiDCodeMetrics.spacingStandard)
                .padding(.top, PiDCodeMetrics.spacingSection)

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

            SettingsNavigationRow(
                title: "自构建",
                systemImage: "arrow.triangle.2.circlepath",
                selected: page == .selfBuild
            ) {
                model.presentSettings(.selfBuild)
            }

            Text("应用")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, PiDCodeMetrics.spacingStandard)
                .padding(.top, PiDCodeMetrics.spacingSection)

            SettingsNavigationRow(
                title: "Host 诊断",
                systemImage: "stethoscope",
                badge: model.hostDiagnosticLog.isEmpty ? nil : model.hostDiagnosticLog.count,
                selected: page == .hostDiagnostics
            ) {
                model.presentSettings(.hostDiagnostics)
            }

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
        case .models:
            ModelSettingsView()

        case .resources:
            ResourcesSettingsView()

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

                    Divider().padding(.leading, 20)

                    SettingsValueRow(
                        title: "界面字号",
                        detail: "在系统文字大小基础上整体缩放界面文本，仅作用于常规层级。"
                    ) {
                        Picker("界面字号", selection: interfaceFontScale) {
                            ForEach(DCodeInterfaceFontScale.allCases) { option in
                                Text(option.label)
                                    .tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 220)
                        .accessibilityHint("选择紧凑、标准或大的界面字号")
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

        case .selfBuild:
            SelfBuildSettingsView()

        case .hostDiagnostics:
            HostDiagnosticsSettingsView()

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

    private var interfaceFontScale: Binding<DCodeInterfaceFontScale> {
        Binding(
            get: { DCodeInterfaceFontScale.resolve(interfaceFontScaleRawValue) },
            set: { newValue in
                interfaceFontScaleRawValue = newValue.rawValue
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

/// 自构建闭环（ADR 0022）：构建候选（隔离目录）→ 校验 → 受控重启 / 回滚。
struct SelfBuildSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRestart = false
    @State private var confirmRollback = false

    var body: some View {
        let selfBuild = model.selfBuild
        SettingsPageContainer(
            title: "自构建",
            subtitle: "在隔离目录构建候选 App，校验后受控替换并重启；失败不影响当前运行。"
        ) {
            VStack(spacing: PiDCodeMetrics.spacingSection) {
                SettingsGroup {
                    HStack(spacing: PiDCodeMetrics.spacingGroup) {
                        Button {
                            Task { await model.startSelfBuild() }
                        } label: {
                            if selfBuild.phase == .building {
                                HStack { ProgressView().controlSize(.small); Text("构建中…") }
                            } else {
                                Text("构建候选 App")
                            }
                        }
                        .controlSize(.large)
                        .buttonStyle(.borderedProminent)
                        .disabled(selfBuild.phase == .building)
                        if let output = selfBuild.lastOutput {
                            Text(output.succeeded ? "上次构建成功 · \(output.durationMs / 1000) 秒" : "上次构建失败")
                                .font(.caption)
                                .foregroundStyle(output.succeeded ? .secondary : Color.orange)
                        }
                    }
                    if let output = selfBuild.lastOutput, !output.outputTail.isEmpty {
                        Divider().padding(.leading, 20)
                        DisclosureGroup("构建输出（最近 \(output.outputTail.count) 行）") {
                            ScrollView {
                                Text(output.outputTail.joined(separator: "\n"))
                                    .font(.caption.monospaced())
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 180)
                        }
                        .font(.caption)
                        .padding(.horizontal, 20)
                        .padding(.vertical, PiDCodeMetrics.spacingGroup)
                    } else {
                        Text("产物写入 dist-candidate，不会触碰当前运行的 App；构建失败只保留输出，不做任何替换。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, PiDCodeMetrics.spacingGroup)
                    }
                }

                if let candidate = selfBuild.candidate {
                    SettingsGroup {
                        candidateRow("App 版本", value: candidate.appVersion)
                        Divider().padding(.leading, 20)
                        candidateRow("内嵌 Host", value: candidate.hostVersion)
                        Divider().padding(.leading, 20)
                        HStack {
                            Text("签名")
                                .font(.body.weight(.medium))
                            Spacer()
                            if candidate.codesignValid {
                                Label("已通过", systemImage: "checkmark.seal.fill")
                                    .foregroundStyle(.green)
                                    .font(.callout)
                            } else {
                                Label("未通过", systemImage: "xmark.seal")
                                    .foregroundStyle(.red)
                                    .font(.callout)
                            }
                        }
                        .padding(.horizontal, 20)
                        .frame(minHeight: 44)
                        if let issue = candidate.issue {
                            Text(issue).font(.caption).foregroundStyle(.orange)
                                .padding(.horizontal, 20)
                                .padding(.bottom, PiDCodeMetrics.spacingGroup)
                        }
                        Divider().padding(.leading, 20)
                        HStack(spacing: PiDCodeMetrics.spacingGroup) {
                            Button("重启到候选") { confirmRestart = true }
                                .controlSize(.large)
                                .disabled(!candidate.isReady || selfBuild.phase == .building)
                            Text("当前会话将在新构建中自动恢复。")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, PiDCodeMetrics.spacingGroup)
                    }
                }

                SettingsGroup {
                    HStack(spacing: PiDCodeMetrics.spacingGroup) {
                        Button("回滚到备份构建") { confirmRollback = true }
                            .controlSize(.large)
                            .disabled(!selfBuild.backupAvailable)
                        if !selfBuild.backupAvailable {
                            Text("尚无备份（替换过一次后可用）。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, PiDCodeMetrics.spacingGroup)
                    Text("备份只保留最近一份；无崩溃自动回滚——若新构建无法启动，请通过 Finder 手动交换 dist/D Code.app.backup。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 20)
                        .padding(.bottom, PiDCodeMetrics.spacingGroup)
                }
            }
        }
        .confirmationDialog(
            "重启到候选构建？当前 App 将被原子替换并重启，会话会自动恢复。",
            isPresented: $confirmRestart,
            titleVisibility: .visible
        ) {
            Button("重启到候选", role: .destructive) {
                Task { await model.restartIntoSelfBuildCandidate() }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog(
            "回滚到备份构建并重启？",
            isPresented: $confirmRollback,
            titleVisibility: .visible
        ) {
            Button("回滚并重启", role: .destructive) {
                Task { await model.rollbackSelfBuild() }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private func candidateRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title)
                .font(.body.weight(.medium))
            Spacer()
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 44)
    }
}

/// Host 子进程 stderr 的只读留存：可能来自任意扩展自身的输出（例如 TUI 专用状态行），
/// 不代表 D Code 或 Host 的真实错误，因此不弹出通知，只在这里如实留存供排查。
struct HostDiagnosticsSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        SettingsPageContainer(
            title: "Host 诊断",
            subtitle: "Host 子进程 stderr 与扩展旁路输出的原始留存，可能来自任意已加载扩展自身；不代表 D Code 或 Host 的真实错误，仅供排查参考。"
        ) {
            if model.hostDiagnosticLog.isEmpty {
                SettingsGroup {
                    Text("暂无诊断记录。")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 20)
                        .frame(minHeight: 60, alignment: .leading)
                }
            } else {
                HStack {
                    Text("最近 \(model.hostDiagnosticLog.count) 条")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("清空") {
                        model.hostDiagnosticLog.removeAll()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .font(.caption)
                }

                SettingsGroup {
                    VStack(spacing: 0) {
                        ForEach(Array(model.hostDiagnosticLog.reversed().enumerated()), id: \.element.id) { index, entry in
                            if index > 0 {
                                Divider().padding(.leading, 20)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.timestamp, format: .dateTime.hour().minute().second())
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.tertiary)
                                Text(entry.message)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                        }
                    }
                }
            }
        }
    }
}

/// 本机资源（ADR 0024 / 0.0.15）：Pi 真实加载并注册成功的资源合同。
/// 扩展包停用 / 启用经 Pi 真实配置写与热重载；Skill / Prompt / Command 无
/// Pi 配置合同，只读展示，不提供开关（诚实降级）。
struct ResourcesSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        SettingsPageContainer(
            title: "本机资源",
            subtitle: "Pi 实际加载并注册成功的扩展、Skill、Prompt 模板与命令；停用扩展包会写入 Pi 配置并热重载。"
        ) {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingSection) {
                if model.resources.isLoading && model.resources.snapshot == nil {
                    SettingsGroup {
                        HStack(spacing: PiDCodeMetrics.spacingGroup) {
                            ProgressView().controlSize(.small)
                            Text("正在读取 Pi 资源…")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 20)
                        .frame(minHeight: 60, alignment: .leading)
                    }
                } else if let issue = model.resources.issue, model.resources.snapshot == nil {
                    SettingsGroup {
                        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingGroup) {
                            Text(issue)
                                .foregroundStyle(.secondary)
                            Button("重试") {
                                Task { await model.loadResources() }
                            }
                        }
                        .padding(20)
                    }
                } else if let snapshot = model.resources.snapshot {
                    packagesSection(snapshot.packages)
                    extensionsSection(snapshot.extensions)
                    skillsSection(snapshot.skills)
                    promptsSection(snapshot.prompts)
                    commandsSection(snapshot.commands)
                    diagnosticsSection(snapshot.diagnostics)
                    Text("资源列表来自 Pi 的真实加载结果；隐藏的 D Code 内联扩展不出现在此页。Skill / Prompt 模板没有对应的 Pi 启停配置，只读展示。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, PiDCodeMetrics.spacingTight)
                }
            }
        }
        .task {
            await model.loadResources()
        }
    }

    private func packagesSection(_ packages: [ResourcePackageEntry]) -> some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
            sectionHeader("扩展包", count: packages.count)
            SettingsGroup {
                if packages.isEmpty {
                    emptyRow("Pi 配置中没有扩展包。")
                } else {
                    ForEach(packages, id: \.id) { package in
                        if packages.first?.id != package.id {
                            Divider().padding(.leading, 20)
                        }
                        HStack(spacing: PiDCodeMetrics.spacingGroup) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(package.source)
                                    .font(.body.weight(.medium))
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Text(package.enabled ? package.kindLabel : "\(package.kindLabel) · 已停用")
                                    .font(.caption)
                                    .foregroundStyle(package.enabled ? Color.secondary : Color.orange)
                            }
                            Spacer(minLength: PiDCodeMetrics.spacingGroup)
                            if package.enabled {
                                Button("停用") {
                                    Task {
                                        await model.setResourcePackageEnabled(package.source, enabled: false)
                                    }
                                }
                                .controlSize(.small)
                                .disabled(model.resources.isMutating)
                                .dCodeAccessibleButton("停用扩展包 \(package.source)")
                            } else {
                                Button("启用") {
                                    Task {
                                        await model.setResourcePackageEnabled(package.source, enabled: true)
                                    }
                                }
                                .controlSize(.small)
                                .buttonStyle(.borderedProminent)
                                .disabled(model.resources.isMutating)
                                .dCodeAccessibleButton("启用扩展包 \(package.source)")
                            }
                        }
                        .padding(.horizontal, 20)
                        .frame(minHeight: 52, alignment: .leading)
                    }
                }
            }
        }
    }

    private func extensionsSection(_ extensions: [ResourceExtensionEntry]) -> some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
            sectionHeader("已加载扩展", count: extensions.count)
            SettingsGroup {
                if extensions.isEmpty {
                    emptyRow("没有已加载的扩展。")
                } else {
                    ForEach(extensions, id: \.id) { entry in
                        if extensions.first?.id != entry.id {
                            Divider().padding(.leading, 20)
                        }
                        HStack(spacing: PiDCodeMetrics.spacingGroup) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.name)
                                    .font(.body.weight(.medium))
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Text(entry.path)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer(minLength: PiDCodeMetrics.spacingGroup)
                            Text("\(entry.toolCount) 工具 · \(entry.commandCount) 命令")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 20)
                        .frame(minHeight: 52, alignment: .leading)
                        .help(entry.path)
                    }
                }
            }
        }
    }

    private func skillsSection(_ skills: [ResourceSkillEntry]) -> some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
            sectionHeader("Skill", count: skills.count)
            SettingsGroup {
                if skills.isEmpty {
                    emptyRow("没有已加载的 Skill。")
                } else {
                    ForEach(skills, id: \.id) { skill in
                        if skills.first?.id != skill.id {
                            Divider().padding(.leading, 20)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: PiDCodeMetrics.spacingGroup) {
                                Text(skill.name)
                                    .font(.body.weight(.medium))
                                if skill.disableModelInvocation {
                                    Text("仅手动")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                            }
                            Text(skill.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, PiDCodeMetrics.spacingGroup)
                        .frame(minHeight: 52, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    private func promptsSection(_ prompts: [ResourcePromptEntry]) -> some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
            sectionHeader("Prompt 模板", count: prompts.count)
            SettingsGroup {
                if prompts.isEmpty {
                    emptyRow("没有已加载的 Prompt 模板。")
                } else {
                    ForEach(prompts, id: \.id) { prompt in
                        if prompts.first?.id != prompt.id {
                            Divider().padding(.leading, 20)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: PiDCodeMetrics.spacingGroup) {
                                Text("/\(prompt.name)")
                                    .font(.body.weight(.medium))
                                if let hint = prompt.argumentHint, !hint.isEmpty {
                                    Text("参数：\(hint)")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                Spacer(minLength: 0)
                            }
                            Text(prompt.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, PiDCodeMetrics.spacingGroup)
                        .frame(minHeight: 52, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    private func commandsSection(_ commands: [ResourceCommandEntry]) -> some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
            sectionHeader("命令", count: commands.count)
            SettingsGroup {
                if commands.isEmpty {
                    emptyRow("没有可调用的命令。")
                } else {
                    ForEach(commands, id: \.id) { command in
                        if commands.first?.id != command.id {
                            Divider().padding(.leading, 20)
                        }
                        HStack(spacing: PiDCodeMetrics.spacingGroup) {
                            Text(command.name)
                                .font(.callout.monospaced().weight(.medium))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(command.description ?? "")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Spacer(minLength: PiDCodeMetrics.spacingGroup)
                            Text(command.source)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 20)
                        .frame(minHeight: 44, alignment: .leading)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func diagnosticsSection(_ diagnostics: [ResourceDiagnosticEntry]) -> some View {
        if !diagnostics.isEmpty {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                sectionHeader("加载诊断", count: diagnostics.count)
                SettingsGroup {
                    ForEach(diagnostics, id: \.id) { entry in
                        if diagnostics.first?.id != entry.id {
                            Divider().padding(.leading, 20)
                        }
                        Text(entry.message)
                            .font(.caption.monospaced())
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                            .padding(.horizontal, 20)
                            .padding(.vertical, PiDCodeMetrics.spacingGroup)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func sectionHeader(_ title: String, count: Int) -> some View {
        Text("\(title)（\(count)）")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 20)
            .accessibilityElement(children: .combine)
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.body)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 20)
            .frame(minHeight: 60, alignment: .leading)
    }
}
