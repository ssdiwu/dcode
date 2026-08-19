import AppKit
import SwiftUI

struct ModelSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var showingAuthentication = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                header

                if let error = model.modelSettingsError {
                    issueBanner(error)
                }

                if let snapshot = model.modelSettings {
                    if snapshot.projectOverrides.isActive {
                        projectOverrideBanner(snapshot)
                    }
                    if !snapshot.settingsErrors.isEmpty {
                        ForEach(snapshot.settingsErrors) { issue in
                            issueBanner(issue.message)
                        }
                    }
                    defaultModelGroup(snapshot)
                    enabledRulesGroup(snapshot)
                    providerCatalog(snapshot)
                    authenticationEntry(snapshot)
                } else if model.isLoadingModelSettings {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("正在读取 Pi 模型目录与设置…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 160)
                } else {
                    ContentUnavailableView(
                        "模型设置不可用",
                        systemImage: "cpu",
                        description: Text("连接 Pi Host 后可读取模型目录。")
                    )
                }
            }
            .frame(maxWidth: 860, alignment: .leading)
            .padding(.horizontal, 48)
            .padding(.vertical, 44)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollContentBackground(.hidden)
        .task(id: model.modelSettingsCwd) {
            await model.reloadModelSettings()
        }
        .sheet(isPresented: $showingAuthentication) {
            ProviderAuthenticationView()
                .interactiveDismissDisabled(model.modelAuthFlow != nil)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("模型")
                        .font(.largeTitle.weight(.semibold))
                    Text("管理 Pi 的全局启用范围与默认模型。当前会话和历史会话不会被改写。")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 24)
                Button {
                    Task { await model.reloadModelSettings(refreshCatalog: true) }
                } label: {
                    Label("刷新目录", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoadingModelSettings || model.isMutatingModelSettings)
                .accessibilityHint("向支持动态目录的 Provider 请求一次更新")
            }
            Text(model.modelSettingsCwd)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(model.modelSettingsCwd)
        }
    }

    private func defaultModelGroup(_ snapshot: ModelSettingsSnapshot) -> some View {
        GroupBox {
            HStack(alignment: .center, spacing: 24) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("默认模型")
                        .font(.body.weight(.medium))
                    Text("只影响之后创建的新 Pi 会话。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 24)
                defaultModelMenu(snapshot)
            }
            .padding(8)

            if snapshot.global.defaultInScope == false {
                Label("当前默认模型不在全局启用范围内，请重新选择。", systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
            }
        }
    }

    private func defaultModelMenu(_ snapshot: ModelSettingsSnapshot) -> some View {
        Menu {
            ForEach(snapshot.providers.filter(\.auth.configured)) { provider in
                let models = provider.models.filter(\.globalEnabled)
                if !models.isEmpty {
                    Section(provider.name) {
                        ForEach(models) { item in
                            Button {
                                Task { await model.updateGlobalDefaultModel(item.model) }
                            } label: {
                                if item.model.provider == snapshot.global.defaultProvider,
                                   item.model.id == snapshot.global.defaultModelId {
                                    Label(item.model.displayName, systemImage: "checkmark")
                                } else {
                                    Text(item.model.displayName)
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "cpu")
                Text(defaultModelLabel(snapshot))
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(minWidth: 210, minHeight: 28, alignment: .trailing)
        }
        .menuStyle(.borderlessButton)
        .disabled(snapshot.selectableDefaultModels.isEmpty || settingsAreBusy)
    }

    private func enabledRulesGroup(_ snapshot: ModelSettingsSnapshot) -> some View {
        GroupBox("全局启用范围") {
            VStack(alignment: .leading, spacing: 14) {
                Text(snapshot.global.unrestricted
                    ? "未设置 enabledModels：所有已认证 Provider 的可用模型都会进入选择器。"
                    : "Pi 按以下精确名称或通配规则决定哪些模型可用。")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                ForEach(snapshot.global.enabledModels, id: \.self) { rule in
                    HStack(spacing: 10) {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Text(rule)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                        Spacer(minLength: 16)
                        Text(ruleMatchText(rule, snapshot: snapshot))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button {
                            Task {
                                await model.updateGlobalEnabledModels(
                                    snapshot.global.enabledModels.filter { $0 != rule }
                                )
                            }
                        } label: {
                            Image(systemName: "minus.circle")
                                .frame(width: 28, height: 28)
                        }
                        .buttonStyle(.plain)
                        .disabled(settingsAreBusy)
                        .help("移除规则 \(rule)")
                        .accessibilityLabel("移除模型规则 \(rule)")
                    }
                }

                if !snapshot.global.diagnostics.isEmpty {
                    ForEach(snapshot.global.diagnostics) { diagnostic in
                        Label(
                            diagnostic.pattern.map { "\($0)：\(diagnostic.message)" } ?? diagnostic.message,
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }
                }

            }
            .padding(8)
        }
    }

    private func providerCatalog(_ snapshot: ModelSettingsSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Provider 与模型目录")
                    .font(.title3.weight(.semibold))
                Spacer()
                if model.isLoadingModelSettings || model.isMutatingModelSettings {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if snapshot.cacheInvalid {
                issueBanner("Pi 模型目录缓存无法读取；当前仍显示内建或静态目录。")
            }
            if let statusMessage = snapshot.refresh.statusMessage {
                Label(
                    statusMessage,
                    systemImage: snapshot.refresh.networkDisabled ? "network.slash" : "arrow.clockwise"
                )
                    .font(.callout)
                    .foregroundStyle(snapshot.refresh.networkDisabled ? Color.secondary : Color.orange)
            }

            let configuredProviders = sortedProviders(snapshot.providers.filter(\.auth.configured))
            if configuredProviders.isEmpty {
                ContentUnavailableView(
                    "尚未关联 Provider",
                    systemImage: "person.crop.circle.badge.plus",
                    description: Text("请使用页面底部的“关联 Provider”入口完成 Pi 认证。")
                )
                .frame(maxWidth: .infinity, minHeight: 160)
            } else {
                ForEach(configuredProviders) { provider in
                    providerGroup(provider, snapshot: snapshot)
                }
            }
        }
    }

    private func providerGroup(
        _ provider: ModelSettingsProvider,
        snapshot: ModelSettingsSnapshot
    ) -> some View {
        GroupBox {
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.name)
                            .font(.headline)
                        Text(provider.id)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(provider.auth.configured ? "已认证" : "未认证")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(provider.auth.configured ? Color.green : Color.secondary)
                    Text(catalogLabel(provider.catalog))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(10)

                if provider.models.isEmpty {
                    Divider()
                    Text("当前目录没有模型")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 56)
                } else {
                    ForEach(provider.models) { item in
                        Divider().padding(.leading, 10)
                        modelRow(item, provider: provider, snapshot: snapshot)
                    }
                }
            }
        }
    }

    private func modelRow(
        _ item: ModelSettingsModel,
        provider: ModelSettingsProvider,
        snapshot: ModelSettingsSnapshot
    ) -> some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(item.model.displayName)
                        .font(.body.weight(.medium))
                    if item.model.provider == snapshot.global.defaultProvider,
                       item.model.id == snapshot.global.defaultModelId {
                        Text("默认")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                    if snapshot.projectOverrides.isActive {
                        Text(item.enabled ? "项目可用" : "项目停用")
                            .font(.caption2)
                            .foregroundStyle(item.enabled ? Color.secondary : Color.orange)
                    }
                }
                HStack(spacing: 8) {
                    Text(item.model.id)
                        .font(.caption.monospaced())
                    if let contextWindow = item.model.contextWindow {
                        Text("上下文 \(ConversationTimingFormatter.tokenText(contextWindow))")
                            .font(.caption)
                    }
                }
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 16)
            modelScopeControl(item, provider: provider, scope: snapshot.global)
        }
        .padding(10)
    }

    @ViewBuilder
    private func modelScopeControl(
        _ item: ModelSettingsModel,
        provider: ModelSettingsProvider,
        scope: ModelSettingsScope
    ) -> some View {
        if !provider.auth.configured {
            Text("需先在 Pi 中认证")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if scope.unrestricted {
            Label("已启用", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if item.canRemoveExactRule {
            Button("移出全局启用") {
                Task {
                    await model.updateGlobalEnabledModels(
                        ModelSettingsRulePolicy.removingExactModel(item, from: scope.enabledModels)
                    )
                }
            }
            .disabled(settingsAreBusy)
        } else if item.globalEnabled {
            Text("已由全局规则启用")
                .font(.caption)
                .foregroundStyle(.secondary)
                .help(item.globalMatchedPatterns.joined(separator: "、"))
        } else {
            Button("加入全局启用") {
                Task {
                    await model.updateGlobalEnabledModels(
                        ModelSettingsRulePolicy.addingExactModel(item, to: scope.enabledModels)
                    )
                }
            }
            .disabled(settingsAreBusy)
        }
    }

    private func issueBanner(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.callout)
            .foregroundStyle(.orange)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private func projectOverrideBanner(_ snapshot: ModelSettingsSnapshot) -> some View {
        Label(
            "当前目录存在 .pi/settings.json 项目覆盖。这里仍只编辑全局设置，模型行会另行标出项目实际状态。",
            systemImage: "folder.badge.gearshape"
        )
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }

    private var settingsAreBusy: Bool {
        model.isLoadingModelSettings || model.isMutatingModelSettings
    }


    private func authenticationEntry(_ snapshot: ModelSettingsSnapshot) -> some View {
        let unavailable = snapshot.providers.filter { !$0.auth.configured }
        return GroupBox {
            HStack(spacing: 16) {
                Image(systemName: "person.crop.circle.badge.plus")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 3) {
                    Text("关联 Provider")
                        .font(.body.weight(.medium))
                    Text(unavailable.isEmpty
                        ? "当前目录中的 Provider 均已完成认证。"
                        : "登录或使用 API 认证后，对应模型才会进入上方目录。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 20)
                Button(unavailable.isEmpty ? "查看" : "关联…") {
                    showingAuthentication = true
                }
                .disabled(settingsAreBusy)
            }
            .padding(8)
        }
    }

    private func defaultModelLabel(_ snapshot: ModelSettingsSnapshot) -> String {
        if let item = snapshot.globalDefaultModel {
            return item.model.displayName
        }
        if let provider = snapshot.global.defaultProvider,
           let modelID = snapshot.global.defaultModelId {
            return "\(provider)/\(modelID)"
        }
        return "未设置"
    }

    private func ruleMatchText(_ rule: String, snapshot: ModelSettingsSnapshot) -> String {
        let count = snapshot.providers.flatMap(\.models)
            .filter { $0.globalMatchedPatterns.contains(rule) }
            .count
        return "匹配 \(count) 个模型"
    }

    private func catalogLabel(_ catalog: ModelSettingsCatalogState) -> String {
        if catalog.refreshFailed { return "刷新失败，保留旧目录" }
        switch catalog.kind {
        case "cached":
            if let checkedAt = catalog.checkedAt,
               let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(checkedAt) {
                return "缓存于 \(date.formatted(date: .abbreviated, time: .shortened))"
            }
            return "缓存目录"
        case "builtIn": return "内建目录"
        default: return "静态目录"
        }
    }

    private func sortedProviders(_ providers: [ModelSettingsProvider]) -> [ModelSettingsProvider] {
        providers.sorted { lhs, rhs in
            if lhs.auth.configured != rhs.auth.configured {
                return lhs.auth.configured
            }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }
}

private struct ProviderAuthenticationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.modelAuthFlow?.providerName ?? "关联 Provider")
                        .font(.title2.weight(.semibold))
                    Text(model.modelAuthFlow == nil
                        ? "认证由 Pi 管理；成功后模型会自动进入 D Code 目录。"
                        : "D Code 只传递本次认证交互，不保存或回显凭据。")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.modelAuthFlow != nil { ProgressView().controlSize(.small) }
            }

            if let flow = model.modelAuthFlow {
                authFlow(flow)
            } else {
                providerList
            }

            HStack {
                Button("关闭", role: .cancel) {
                    Task {
                        if model.modelAuthFlow != nil,
                           !(await model.cancelModelAuthentication()) { return }
                        dismiss()
                    }
                }
                Spacer()
            }
        }
        .padding(24)
        .frame(width: 620, height: 520)
        .onChange(of: model.modelAuthFlow?.prompt?.id) { _, _ in value = "" }
        .onDisappear {
            value = ""
        }
    }

    private var providerList: some View {
        let providers = model.modelSettings?.providers.filter { !$0.auth.configured } ?? []
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if providers.isEmpty {
                    ContentUnavailableView(
                        "没有待关联的 Provider",
                        systemImage: "checkmark.circle",
                        description: Text("当前可用 Provider 均已完成认证。")
                    )
                    .frame(maxWidth: .infinity, minHeight: 300)
                } else {
                    ForEach(providers) { provider in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(provider.name).font(.headline)
                                    Text(provider.id)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("未关联")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if provider.auth.availableMethods.isEmpty {
                                Text("该 Provider 需要在 Pi 或系统环境中完成配置。")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            } else {
                                HStack(spacing: 8) {
                                    ForEach(provider.auth.availableMethods) { method in
                                        Button(method.label) {
                                            Task { await model.startModelAuthentication(provider: provider, method: method) }
                                        }
                                        .disabled(!method.interactive)
                                        .help(method.interactive
                                            ? "使用 Pi 的 \(method.label) 流程关联 \(provider.name)"
                                            : "该方式需要在 Pi 或系统环境中配置")
                                    }
                                }
                            }
                        }
                        .padding(14)
                        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func authFlow(_ flow: ModelAuthFlow) -> some View {
        if let event = flow.events.last {
            VStack(alignment: .leading, spacing: 10) {
                if let message = event.message {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                if let userCode = flow.events.last(where: { $0.userCode != nil })?.userCode {
                    LabeledContent("设备代码") {
                        Text(userCode).font(.body.monospaced().weight(.semibold)).textSelection(.enabled)
                    }
                }
                if let linkEvent = flow.events.last(where: { $0.url != nil }),
                   let rawURL = linkEvent.url,
                   let url = URL(string: rawURL) {
                    Button(linkEvent.linkLabel ?? "在浏览器中打开") { NSWorkspace.shared.open(url) }
                }
            }
            .padding(12)
            .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        }

        if let prompt = flow.prompt {
            VStack(alignment: .leading, spacing: 12) {
                Text(prompt.message)
                    .font(.body.weight(.medium))
                promptControl(prompt)
            }
            .padding(14)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
        }

        if let error = flow.error {
            Label(error, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("返回 Provider 列表") {
                Task { await model.cancelModelAuthentication() }
            }
        }

        Spacer(minLength: 0)
    }

    @ViewBuilder
    private func promptControl(_ prompt: ModelAuthPrompt) -> some View {
        switch prompt.type {
        case "secret":
            SecureField(prompt.placeholder ?? "输入 API Key", text: $value)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submit(prompt, value: value) }
            authPromptActions(prompt)
        case "text", "manual_code":
            TextField(prompt.placeholder ?? "输入", text: $value)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submit(prompt, value: value) }
            authPromptActions(prompt)
        case "select":
            ForEach(prompt.options) { option in
                Button {
                    submit(prompt, value: option.id)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.label)
                        if let description = option.description {
                            Text(description).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        default:
            Text("当前 Pi 认证步骤暂不受支持。")
                .foregroundStyle(.orange)
        }
    }

    private func authPromptActions(_ prompt: ModelAuthPrompt) -> some View {
        HStack {
            Button("取消") {
                value = ""
                Task { await model.respondToModelAuthPrompt(prompt, value: nil, cancelled: true) }
            }
            Spacer()
            Button("继续") { submit(prompt, value: value) }
                .keyboardShortcut(.defaultAction)
                .disabled(value.isEmpty)
        }
    }

    private func submit(_ prompt: ModelAuthPrompt, value: String) {
        guard !value.isEmpty else { return }
        let response = value
        self.value = ""
        Task { await model.respondToModelAuthPrompt(prompt, value: response) }
    }
}
